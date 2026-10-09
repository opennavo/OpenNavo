package homebrew

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestSharedVersionCases(t *testing.T) {
	data, err := os.ReadFile("../../testdata/version_cases.json")
	require.NoError(t, err)
	var cases []struct {
		Left, Right string
		Expected    *int
	}
	require.NoError(t, json.Unmarshal(data, &cases))
	for _, example := range cases {
		t.Run(example.Left+"_"+example.Right, func(t *testing.T) {
			result, comparable := CompareVersion(example.Left, example.Right)
			if example.Expected == nil {
				require.False(t, comparable)
			} else {
				require.True(t, comparable)
				require.Equal(t, *example.Expected, result)
			}
		})
	}
}
