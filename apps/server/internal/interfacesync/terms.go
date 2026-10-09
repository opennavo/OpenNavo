package interfacesync

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

var DefaultBrands = []string{"OpenNavo", "Homebrew", "Brewfile", "macOS", "GitHub", "SHA-256"}
var TechnicalTerms = []string{"Token", "App", "API", "URL", "JSON", "HTTP", "HTTPS", "Enter", "Esc", "Ctrl", "⌘"}

// CJK text usually has no spaces; adjacent kana or Han characters are not part of a brand name.
func wordRune(r rune) bool {
	return r == '_' || unicode.IsDigit(r) || (unicode.IsLetter(r) && !unicode.Is(unicode.Han, r) && !unicode.Is(unicode.Hiragana, r) && !unicode.Is(unicode.Katakana, r))
}
func termSpans(text, term string, folded bool) [][2]int {
	var spans [][2]int
	if term == "" {
		return spans
	}
	haystack, needle := text, term
	if folded {
		haystack = foldASCII(text)
		needle = foldASCII(term)
	}
	// Technical terms contain only ASCII and the command symbol, so case folding preserves byte offsets.
	for offset := 0; offset < len(haystack); {
		index := strings.Index(haystack[offset:], needle)
		if index < 0 {
			break
		}
		start := offset + index
		end := start + len(needle)
		before, _ := utf8.DecodeLastRuneInString(haystack[:start])
		after, _ := utf8.DecodeRuneInString(haystack[end:])
		if (start == 0 || !wordRune(before)) && (end == len(haystack) || !wordRune(after)) {
			spans = append(spans, [2]int{start, end})
		}
		offset = end
	}
	return spans
}
func countTerm(text, term string) int { return len(termSpans(text, term, false)) }
func stripTerm(text, term string, folded bool) string {
	spans := termSpans(text, term, folded)
	for i := len(spans) - 1; i >= 0; i-- {
		span := spans[i]
		text = text[:span[0]] + text[span[1]:]
	}
	return text
}

func foldASCII(text string) string {
	value := []byte(text)
	for i, b := range value {
		if b >= 'A' && b <= 'Z' {
			value[i] = b + ('a' - 'A')
		}
	}
	return string(value)
}
