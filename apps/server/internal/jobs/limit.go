package jobs

import "context"

func WithLLMLimit(handlers Handlers, concurrency int) Handlers {
	limited := Handlers{}
	semaphore := make(chan struct{}, max(1, concurrency))
	for taskType, handler := range handlers {
		if handler == nil || taskType != "translate:content" {
			limited[taskType] = handler
			continue
		}
		limited[taskType] = func(ctx context.Context, payload Payload) (map[string]any, error) {
			select {
			case semaphore <- struct{}{}:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			defer func() { <-semaphore }()
			return handler(ctx, payload)
		}
	}
	return limited
}
