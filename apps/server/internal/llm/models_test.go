package llm

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestCostAndUTF8Limits(t *testing.T) {
	require.Equal(t, 0.0002, (Price{Input: 1, Output: 2}).Cost(Attempt{PromptTokens: 100, CompletionTokens: 50}))
	require.Equal(t, "中", TruncateBytes(strings.Repeat("中文", 100), 4))
	require.Equal(t, "test", TruncateBytes("test", 4))
}
