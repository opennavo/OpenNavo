package jobs

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestContentTranslationConcurrencyLimit(t *testing.T) {
	var active, maximum atomic.Int32
	entered := make(chan struct{}, 8)
	release := make(chan struct{})
	handler := func(context.Context, Payload) (map[string]any, error) {
		n := active.Add(1)
		for previous := maximum.Load(); n > previous; previous = maximum.Load() {
			if maximum.CompareAndSwap(previous, n) {
				break
			}
		}
		entered <- struct{}{}
		<-release
		active.Add(-1)
		return nil, nil
	}
	handlers := WithLLMLimit(Handlers{"translate:content": handler}, 2)
	var workers sync.WaitGroup
	for range 8 {
		workers.Go(func() {
			kind := "translate:content"
			_, _ = handlers[kind](context.Background(), Payload{})
		})
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	for range 2 {
		select {
		case <-entered:
		case <-ctx.Done():
			t.Fatal("limited jobs did not start")
		}
	}
	require.Equal(t, int32(2), active.Load())
	canceled, stop := context.WithCancel(context.Background())
	stop()
	_, err := handlers["translate:content"](canceled, Payload{})
	require.ErrorIs(t, err, context.Canceled)
	close(release)
	workers.Wait()
	require.Equal(t, int32(2), maximum.Load())
}
