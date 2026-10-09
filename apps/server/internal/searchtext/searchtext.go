package searchtext

import (
	"strings"
	"unicode"

	"github.com/opennavo/opennavo/server/internal/pinyin"
	"golang.org/x/text/unicode/norm"
)

func Normalize(query string) string {
	query = strings.ToLower(norm.NFKC.String(query))
	var cleaned strings.Builder
	for _, r := range query {
		if unicode.IsLetter(r) || unicode.IsNumber(r) || unicode.IsSpace(r) || strings.ContainsRune("@.+-_/", r) {
			cleaned.WriteRune(r)
		}
	}
	query = strings.Join(strings.Fields(cleaned.String()), " ")
	runes := []rune(query)
	if len(runes) > 64 {
		runes = runes[:64]
	}
	return string(runes)
}
func EscapeLike(query string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(query)
}

func Build(token string, names []string, displayName string, tags, binaries []string) string {
	parts := append([]string{token}, names...)
	parts = append(parts, displayName)
	parts = append(parts, tags...)
	parts = append(parts, binaries...)
	for _, name := range append(append([]string{}, names...), displayName) {
		full, initials := pinyin.Spellings(name)
		parts = append(parts, full, initials)
	}
	seen := map[string]bool{}
	unique := []string{}
	for _, part := range parts {
		part = strings.ToLower(strings.TrimSpace(norm.NFKC.String(part)))
		if part != "" && !seen[part] {
			seen[part] = true
			unique = append(unique, part)
		}
	}
	return strings.Join(unique, " ")
}
