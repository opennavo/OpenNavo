package pinyin

import (
	"strings"

	gopinyin "github.com/mozillazg/go-pinyin"
)

func Spellings(text string) (string, string) {
	args := gopinyin.Args{Style: gopinyin.Normal, Heteronym: false, Fallback: func(rune, gopinyin.Args) []string { return nil }}
	words := gopinyin.LazyPinyin(text, args)
	var initials strings.Builder
	for _, word := range words {
		if word != "" {
			initials.WriteByte(word[0])
		}
	}
	return strings.Join(words, ""), initials.String()
}
