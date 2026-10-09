package searchtext

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestQueryNormalizationAndLikeEscaping(t *testing.T) {
	for input, want := range map[string]string{"  ＶＳＣＯＤＥ\t ": "vscode", " Foo，  Bar! ": "foo bar", "@VueUse/Core C++ a_b 1.2": "@vueuse/core c++ a_b 1.2", "微信 😀": "微信", strings.Repeat("微", 65): strings.Repeat("微", 64)} {
		require.Equal(t, want, Normalize(input))
	}
	require.Equal(t, `a\_b\%\\c`, EscapeLike(`a_b%\c`))
}
func TestSearchTextIncludesPinyinTagsAndBinaries(t *testing.T) {
	text := Build("wechat", []string{"WeChat", "微信", "Wechat"}, "微信", []string{"聊天"}, []string{"wx"})
	require.Equal(t, "wechat 微信 聊天 wx weixin", text)
	require.Contains(t, Build("ripgrep", []string{"ripgrep"}, "", nil, []string{"rg"}), "rg")
}
