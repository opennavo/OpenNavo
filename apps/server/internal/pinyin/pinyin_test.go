package pinyin

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestDocumentedSpellings(t *testing.T) {
	for _, example := range []struct{ Text, Full, Initials string }{{"微信", "weixin", "wx"}, {"网易云音乐", "wangyiyunyinle", "wyyyl"}, {"WeChat 微信", "weixin", "wx"}, {"ripgrep", "", ""}} {
		full, initials := Spellings(example.Text)
		require.Equal(t, example.Full, full)
		require.Equal(t, example.Initials, initials)
	}
}
