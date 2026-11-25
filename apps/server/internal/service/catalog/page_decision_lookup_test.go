package catalog

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestSplitLocaleTakesTheLongestPrefix(t *testing.T) {
	for _, tc := range []struct{ path, locale, rest string }{
		{"/", "en-US", "/"},
		{"/apps/x", "en-US", "/apps/x"},
		{"/zh", "zh-CN", "/"},
		{"/zh/apps/x", "zh-CN", "/apps/x"},
		{"/zh-hant", "zh-Hant", "/"},
		{"/zh-hant/apps/x", "zh-Hant", "/apps/x"},
		{"/zhx/apps", "en-US", "/zhx/apps"},
		{"/pt/articles/a", "pt-BR", "/articles/a"},
	} {
		locale, rest := splitLocale(tc.path)
		require.Equal(t, tc.locale, locale, tc.path)
		require.Equal(t, tc.rest, rest, tc.path)
	}
	require.Equal(t, "/zh", localePath("zh-CN", "/"))
	require.Equal(t, "/", localePath("en-US", "/"))
	require.Equal(t, "/zh-hant/articles/a", localePath("zh-Hant", "/articles/a"))
}

// The admin check reads ?page= exactly like the web's list contract, so a URL the page answers with 404
// (leading zero, repeat, empty, out of range) is never reported as a listed page.
func TestVersionsPageNumberMatchesTheWebContract(t *testing.T) {
	for _, tc := range []struct {
		values []string
		page   int
		ok     bool
	}{
		{nil, 1, true},
		{[]string{"1"}, 1, true},
		{[]string{"2"}, 2, true},
		{[]string{"999999"}, 999999, true},
		{[]string{"0"}, 0, false},
		{[]string{"00"}, 0, false},
		{[]string{"01"}, 0, false},
		{[]string{"02"}, 0, false},
		{[]string{""}, 0, false},
		{[]string{"-1"}, 0, false},
		{[]string{"1.5"}, 0, false},
		{[]string{"2a"}, 0, false},
		{[]string{"1000000"}, 0, false},
		{[]string{"1", "2"}, 0, false},
	} {
		page, ok := versionsPageNumber(tc.values)
		require.Equal(t, tc.ok, ok, tc.values)
		if tc.ok {
			require.Equal(t, tc.page, page, tc.values)
		}
	}
}

// Labels encode like the web's labelPath: encodeURIComponent with @, + and : kept.
func TestBackgroundSegmentMatchesTheWebLabelPath(t *testing.T) {
	for label, want := range map[string]string{
		"homebrew.mxcl.postgresql@16": "homebrew.mxcl.postgresql@16",
		"com.example.helper":          "com.example.helper",
		"Example Login":               "Example%20Login",
		"a+b:c":                       "a+b:c",
		"it's (fine)!*~":              "it's%20(fine)!*~",
		"数据":                          "%E6%95%B0%E6%8D%AE",
		"x&y=z%":                      "x%26y%3Dz%25",
	} {
		require.Equal(t, want, backgroundSegment(label), label)
	}
}
