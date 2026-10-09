package changelog

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strings"
	"unicode/utf8"
)

var htmlComments = regexp.MustCompile(`(?s)<!--.*?-->`)
var htmlTags = regexp.MustCompile(`</?[A-Za-z][A-Za-z0-9:-]*(?:\s[^>]*?)?/?>`)
var htmlDeclarations = regexp.MustCompile(`(?s)<![^>]*>|<\?[^>]*\?>`)
var markdownImages = regexp.MustCompile(`!\[([^\]]*)\]\(([^)]+)\)`)

func NormalizeMarkdown(body string) (string, string) {
	body = strings.ReplaceAll(body, "\r\n", "\n")
	body = htmlComments.ReplaceAllString(body, "")
	body = markdownImages.ReplaceAllString(body, "[Image: $1]($2)")
	lines := strings.Split(body, "\n")
	out := []string{}
	fence := ""
	blank := false
	text := []string{}
	flush := func() {
		// Process tags across lines, preserving code and Markdown URL/email autolinks.
		pieces := strings.Split(strings.Join(text, "\n"), "`")
		for i := 0; i < len(pieces); i += 2 {
			pieces[i] = htmlTags.ReplaceAllString(pieces[i], "")
			pieces[i] = htmlDeclarations.ReplaceAllString(pieces[i], "")
		}
		for _, line := range strings.Split(strings.Join(pieces, "`"), "\n") {
			if strings.TrimSpace(line) == "" {
				if blank {
					continue
				}
				blank = true
			} else {
				blank = false
			}
			out = append(out, strings.TrimRight(line, " \t"))
		}
		text = nil
	}
	for _, line := range lines {
		trim := strings.TrimSpace(line)
		if strings.HasPrefix(trim, "```") || strings.HasPrefix(trim, "~~~") {
			if len(text) > 0 {
				flush()
			}
			marker := trim[:3]
			switch fence {
			case "":
				fence = marker
			case marker:
				fence = ""
			}
			out = append(out, line)
			blank = false
			continue
		}
		if fence == "" {
			text = append(text, line)
			continue
		}
		out = append(out, strings.TrimRight(line, " \t"))
	}
	if len(text) > 0 {
		flush()
	}
	body = strings.TrimSpace(strings.Join(out, "\n"))
	if len(body) > 200*1024 {
		body = body[:200*1024-len("\n\n(Source text truncated because it is too long)")]
		for !utf8.ValidString(body) {
			body = body[:len(body)-1]
		}
		body += "\n\n(Source text truncated because it is too long)"
	}
	hash := sha256.Sum256([]byte(body))
	return body, hex.EncodeToString(hash[:])
}
