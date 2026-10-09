package i18n

import (
	"context"
	"sort"
	"strconv"
	"strings"
)

func Valid(value string) bool {
	_, ok := Metadata[LocaleCode(value)]
	return ok
}

// Fold regional variants only for supported languages into product locales; do not guess other languages.
func canonical(value string) string {
	value = strings.ReplaceAll(strings.ToLower(strings.TrimSpace(value)), "_", "-")
	for _, locale := range Locales {
		code := strings.ToLower(string(locale))
		if value == code || strings.Split(value, "-")[0] == strings.Split(code, "-")[0] {
			return string(locale)
		}
	}
	return ""
}

func Negotiate(query, header string) string {
	if Valid(query) {
		return query
	}
	type preference struct {
		locale  string
		quality float64
	}
	var choices []preference
	for _, item := range strings.Split(header, ",") {
		parts := strings.Split(item, ";")
		locale, quality := canonical(parts[0]), 1.0
		for _, parameter := range parts[1:] {
			key, value, found := strings.Cut(strings.TrimSpace(parameter), "=")
			if found && strings.EqualFold(key, "q") {
				parsed, err := strconv.ParseFloat(value, 64)
				if err != nil || !(parsed > 0 && parsed <= 1) {
					quality = 0
				} else {
					quality = parsed
				}
			}
		}
		if locale != "" && quality > 0 {
			choices = append(choices, preference{locale, quality})
		}
	}
	sort.SliceStable(choices, func(i, j int) bool { return choices[i].quality > choices[j].quality })
	if len(choices) > 0 {
		return choices[0].locale
	}
	return string(DefaultLocale)
}

func Fallback(requested, source string) []string {
	result := []string{}
	for _, value := range []string{requested, string(DefaultLocale), source} {
		if !Valid(value) {
			continue
		}
		duplicate := false
		for _, previous := range result {
			duplicate = duplicate || value == previous
		}
		if !duplicate {
			result = append(result, value)
		}
	}
	return result
}

type localeContextKey struct{}

func WithLocale(ctx context.Context, locale string) context.Context {
	if !Valid(locale) {
		locale = string(DefaultLocale)
	}
	return context.WithValue(ctx, localeContextKey{}, locale)
}
func FromContext(ctx context.Context) string {
	if value, ok := ctx.Value(localeContextKey{}).(string); ok && Valid(value) {
		return value
	}
	return string(DefaultLocale)
}
