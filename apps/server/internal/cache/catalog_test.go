package cache

import (
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

func TestInvalidationChannelIncludesNonDefaultRedisDatabase(t *testing.T) {
	for number, expected := range map[int]string{0: "cache:invalidate", 9: "cache:invalidate:db:9", 10: "cache:invalidate:db:10"} {
		client := redis.NewClient(&redis.Options{DB: number})
		require.Equal(t, expected, invalidationChannel(client))
		require.NoError(t, client.Close())
	}
}

func TestCoalescerAppliesQuietBatchesAtOnceAndMergesBursts(t *testing.T) {
	start := time.Date(2026, 10, 10, 0, 0, 0, 0, time.UTC)
	batch := coalescer{interval: 10 * time.Second}
	due, ok := batch.add(start, []string{"c:pkg:*", "*", "session:*"})
	require.True(t, ok)
	require.Equal(t, start, due, "the first invalidation after a quiet interval must not wait")
	require.Equal(t, []string{"c:pkg:*"}, batch.take(start), "invalid patterns are dropped")

	due, ok = batch.add(start.Add(time.Second), []string{"c:rel:*"})
	require.True(t, ok)
	require.Equal(t, start.Add(10*time.Second), due, "a burst waits for the interval since the previous pass")
	due, ok = batch.add(start.Add(2*time.Second), []string{"c:home:*", "c:rel:*"})
	require.True(t, ok)
	require.Equal(t, start.Add(10*time.Second), due)
	require.Equal(t, []string{"c:home:*", "c:rel:*"}, batch.take(due))

	_, _ = batch.add(start.Add(11*time.Second), []string{"c:pkg:*"})
	_, _ = batch.add(start.Add(12*time.Second), []string{"c:*"})
	require.Equal(t, []string{"c:*"}, batch.take(start.Add(20*time.Second)), "c:* supersedes narrower patterns")
	require.Nil(t, batch.take(start.Add(21*time.Second)))

	_, ok = batch.add(start.Add(22*time.Second), []string{"session:*"})
	require.False(t, ok, "a batch of invalid patterns schedules nothing")
	due, ok = batch.add(start.Add(time.Minute), []string{"c:cat:*"})
	require.True(t, ok)
	require.Equal(t, start.Add(time.Minute), due)
}

func TestPatternLiteralEscapesGlobMetacharacters(t *testing.T) {
	require.Equal(t, "visual-studio-code", PatternLiteral("visual-studio-code"))
	require.Equal(t, `a\*b\?c\[d\]e\\f`, PatternLiteral(`a*b?c[d]e\f`))
}
