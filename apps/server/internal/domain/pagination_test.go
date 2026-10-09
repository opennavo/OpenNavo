package domain

import (
	"math"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestPageOffsetPreservesBoundariesWithoutOverflow(t *testing.T) {
	for _, test := range []struct {
		current, size int
		total         int64
		offset        int
		found         bool
	}{
		{1, 24, 60, 0, true}, {3, 24, 60, 48, true}, {4, 24, 60, 0, false},
		{3, 20, 40, 0, false}, {1, 20, 0, 0, false}, {0, 20, 60, 0, false}, {1, 0, 60, 0, false},
		{math.MaxInt, 100, 60, 0, false}, {math.MaxInt, 1, math.MaxInt64, math.MaxInt - 1, true},
	} {
		offset, found := PageOffset(test.current, test.size, test.total)
		require.Equal(t, test.offset, offset)
		require.Equal(t, test.found, found)
	}
}
