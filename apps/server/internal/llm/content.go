package llm

import (
	"context"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	lingua "github.com/pemistahl/lingua-go"

	"github.com/opennavo/opennavo/server/internal/i18n"
)

type ContentInput struct {
	RefID        int64                        `json:"-"`
	SourceLocale string                       `json:"sourceLocale"`
	Targets      []string                     `json:"targets"`
	Fields       map[string]string            `json:"fields"`
	Limits       map[string]int               `json:"limits"`
	Protected    []string                     `json:"protected"`
	Glossary     map[string]map[string]string `json:"glossary"`
	Strict       bool                         `json:"strict"`
}
type ContentOutput map[string]map[string]string
type ContentTranslator interface {
	TranslateContent(context.Context, ContentInput) (ContentOutput, Usage, error)
}

var literals = regexp.MustCompile("(?s)```.*?```|~~~.*?~~~|`[^`\\n]+`|https?://[^\\s<>\\)\\]，。；！？、\\p{Han}\\p{Hiragana}\\p{Katakana}\\x{3000}-\\x{303F}\\x{FF00}-\\x{FFEF}]+|(?:[A-Za-z]:)?/[^\\s<>\\)\\]，。；！？、\\p{Han}\\p{Hiragana}\\p{Katakana}\\x{3000}-\\x{303F}\\x{FF00}-\\x{FFEF}]+|\\b[A-Z][A-Z0-9_]*_[A-Z0-9_]+\\b|\\bv?\\d+\\.\\d+(?:\\.[A-Za-z0-9]+)*(?:[-+][A-Za-z0-9.]+)?\\b|\\$\\{[^}]+\\}|\\{[A-Za-z_][A-Za-z0-9_]*\\}")
var markdownLinks = regexp.MustCompile(`!?\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)`)
var commandLines = regexp.MustCompile(`(?m)^\s*(?:\$ |brew |sudo |curl |git |npm |pnpm |uv |python3 |docker ).+$`)

func LiteralSpans(s string) []string {
	out := literals.FindAllString(s, -1)
	out = append(out, commandLines.FindAllString(s, -1)...)
	for _, link := range markdownLinks.FindAllStringSubmatch(s, -1) {
		out = append(out, "link:"+link[1])
	}
	for i, v := range out {
		if strings.HasPrefix(v, "/") || strings.HasPrefix(v, "http") {
			out[i] = strings.TrimRight(v, ".,，。；;！!")
		}
	}
	sort.Strings(out)
	return out
}
func stripLiterals(s string, protected []string) string {
	s = literals.ReplaceAllString(s, "")
	s = commandLines.ReplaceAllString(s, "")
	for _, p := range protected {
		if p != "" {
			s = strings.ReplaceAll(s, p, "")
		}
	}
	return strings.TrimSpace(s)
}
func contentFailure(reason string) error { return &Failure{Reason: reason} }
func ValidateContent(out ContentOutput, in ContentInput) error {
	if !i18n.Valid(in.SourceLocale) || len(out) != len(in.Targets) {
		return contentFailure("invalid_schema")
	}
	for _, locale := range in.Targets {
		fields, ok := out[locale]
		if !ok || !i18n.Valid(locale) || locale == in.SourceLocale || len(fields) != len(in.Fields) {
			return contentFailure("invalid_schema")
		}
		var sourceText, targetText strings.Builder
		for key, source := range in.Fields {
			target, ok := fields[key]
			if !ok || strings.TrimSpace(target) == "" {
				return contentFailure("missing_field")
			}
			if maximum := in.Limits[key]; maximum > 0 && utf8.RuneCountInString(target) > maximum {
				return contentFailure("too_long")
			}
			if !reflect.DeepEqual(LiteralSpans(source), LiteralSpans(target)) {
				return contentFailure("changed_literal")
			}
			for _, term := range in.Protected {
				if term != "" && strings.Count(source, term) != strings.Count(target, term) {
					return contentFailure("changed_brand")
				}
			}
			for term, translations := range in.Glossary {
				if translated := translations[locale]; translated != "" && strings.Contains(source, term) && !strings.Contains(target, translated) {
					return contentFailure("missing_glossary")
				}
			}
			sourceText.WriteString(stripLiterals(source, in.Protected))
			sourceText.WriteByte(' ')
			targetText.WriteString(stripLiterals(target, in.Protected))
			targetText.WriteByte(' ')
		}
		src, dst := strings.TrimSpace(sourceText.String()), strings.TrimSpace(targetText.String())
		if src != "" && src == dst {
			return contentFailure("untranslated")
		}
		if src != "" && !MatchesLanguage(dst, locale) {
			return contentFailure("wrong_language")
		}
	}
	return nil
}

var latinDetector = lingua.NewLanguageDetectorBuilder().FromLanguages(lingua.English, lingua.Spanish, lingua.Portuguese, lingua.French, lingua.German, lingua.Italian).WithMinimumRelativeDistance(0.1).Build()

// Validate character scripts first, then distinguish Latin languages with the offline model; reject uncertainty and retry strictly.
func MatchesLanguage(text, locale string) bool {
	han, kana, cyrillic, latin := 0, 0, 0, 0
	for _, r := range text {
		switch {
		case unicode.In(r, unicode.Hiragana, unicode.Katakana):
			kana++
		case unicode.Is(unicode.Han, r):
			han++
		case unicode.Is(unicode.Cyrillic, r):
			cyrillic++
		case unicode.Is(unicode.Latin, r):
			latin++
		}
	}
	switch locale {
	case "zh-CN":
		return han > 0 && kana == 0 && cyrillic == 0
	case "ja-JP":
		return (kana > 0 || han > 0) && cyrillic == 0
	case "ru-RU":
		return cyrillic > 0 && han == 0 && kana == 0
	}
	if han+kana+cyrillic > 0 || latin == 0 {
		return false
	}
	language, confident := latinDetector.DetectLanguageOf(text)
	expected, ok := map[string]lingua.Language{"en-US": lingua.English, "es-ES": lingua.Spanish, "pt-BR": lingua.Portuguese}[locale]
	return ok && confident && language == expected
}
