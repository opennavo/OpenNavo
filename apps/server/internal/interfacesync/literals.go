package interfacesync

import (
	"regexp"
	"sort"
	"strings"
)

// UI commands must be enclosed in backticks; dollar signs are not vue-i18n placeholders.
var interfaceLiterals = regexp.MustCompile("(?s)```.*?```|`[^`\\n]+`|https?://[^\\s<>\\)\\]，。；！？、\\p{Han}\\p{Hiragana}\\p{Katakana}\\x{3000}-\\x{303F}\\x{FF00}-\\x{FFEF}]+|(?:[A-Za-z]:)?/[^\\s<>\\)\\]，。；！？、\\p{Han}\\p{Hiragana}\\p{Katakana}\\x{3000}-\\x{303F}\\x{FF00}-\\x{FFEF}]+|\\bv?\\d+\\.\\d+(?:\\.[A-Za-z0-9]+)*(?:[-+][A-Za-z0-9.]+)?\\b|\\{[A-Za-z_][A-Za-z0-9_]*\\}")

func LiteralSpans(value string) []string {
	spans := interfaceLiterals.FindAllString(value, -1)
	for i, span := range spans {
		if strings.HasPrefix(span, "http") || strings.HasPrefix(span, "/") {
			spans[i] = strings.TrimRight(span, ".,:;!?")
		}
	}
	sort.Strings(spans)
	return spans
}
