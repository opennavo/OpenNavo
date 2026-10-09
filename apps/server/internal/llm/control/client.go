package control

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/hibiken/asynq"
	"github.com/opennavo/opennavo/server/internal/config"
	"github.com/opennavo/opennavo/server/internal/llm"
	gateway "github.com/opennavo/opennavo/server/internal/llm/openai"
	"github.com/redis/go-redis/v9"
)

type Repository interface {
	LLMMonth(context.Context, time.Time) (llm.Totals, error)
	LLMPrice(context.Context, string) (*llm.Price, error)
	SaveLLMUsage(context.Context, string, int64, llm.Attempt, *float64) error
}
type Client struct {
	Content           llm.ContentTranslator
	Store             Repository
	Redis             *redis.Client
	Config            config.Config
	Now               func() time.Time
	TranslationConfig func(context.Context, config.Config) (config.Config, error)
}

var acquire = redis.NewScript(`local clock=redis.call('TIME')
local now=tonumber(clock[1])*1000+tonumber(clock[2])/1000
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now)
if redis.call('ZCARD',KEYS[1])>=tonumber(ARGV[2]) then return {0,200} end
local usage=math.max(tonumber(redis.call('HGET',KEYS[2],'tokens')) or 0,tonumber(ARGV[4]))
local cost=math.max(tonumber(redis.call('HGET',KEYS[2],'cost')) or 0,tonumber(ARGV[5]))
redis.call('HSET',KEYS[2],'tokens',usage,'cost',cost)
local reservations=redis.call('HGETALL',KEYS[3])
local reserved=0 local reservedCost=0
for i=1,#reservations,2 do
 local t,c,expires=string.match(reservations[i+1],'([^:]+):([^:]+):([^:]+)')
 if tonumber(expires)<=now then redis.call('HDEL',KEYS[3],reservations[i]) else reserved=reserved+tonumber(t) reservedCost=reservedCost+tonumber(c) end
end
if usage+reserved+tonumber(ARGV[6])>tonumber(ARGV[8]) or (tonumber(ARGV[9])>0 and cost+reservedCost+tonumber(ARGV[7])>tonumber(ARGV[9])) then return {-1,0} end
local interval=60000/tonumber(ARGV[10])
local tat=tonumber(redis.call('GET',KEYS[4])) or now
local allowAt=tat-(tonumber(ARGV[10])-1)*interval
if now<allowAt then return {0,math.ceil(allowAt-now)} end
local next=math.max(tat,now)+interval
redis.call('SET',KEYS[4],string.format('%.0f',next),'PX',math.ceil(next-now))
redis.call('ZADD',KEYS[1],now+tonumber(ARGV[3]),ARGV[1])
redis.call('HSET',KEYS[3],ARGV[1],ARGV[6]..':'..ARGV[7]..':'..string.format('%.0f',now+tonumber(ARGV[3])))
redis.call('EXPIRE',KEYS[2],ARGV[11]) redis.call('EXPIRE',KEYS[3],ARGV[11])
return {1,0}`)
var settle = redis.NewScript(`if redis.call('HDEL',KEYS[3],ARGV[1])==1 then
 redis.call('HINCRBY',KEYS[2],'tokens',ARGV[2]) redis.call('HINCRBY',KEYS[2],'cost',ARGV[3]) end
redis.call('ZREM',KEYS[1],ARGV[1]) return 1`)

func (c *Client) keys(now time.Time) []string {
	month := now.UTC().Format("2006-01")
	return []string{"llm:{gate}:leases", "llm:{gate}:usage:" + month, "llm:{gate}:reserved:" + month, "llm:{gate}:rpm"}
}
func (c *Client) reserve(ctx context.Context, model string, tokens int64) (string, []string, *llm.Price, error) {
	if !c.Config.LLMEnabled {
		return "", nil, nil, llm.ErrPaused
	}
	reason, pauseErr := c.Redis.Get(ctx, "llm:paused_reason").Result()
	if pauseErr != nil && !errors.Is(pauseErr, redis.Nil) {
		return "", nil, nil, pauseErr
	}
	if reason != "" && reason != "disabled" {
		return "", nil, nil, llm.ErrPaused
	}
	now := time.Now().UTC()
	if c.Now != nil {
		now = c.Now().UTC()
	}
	totals, err := c.Store.LLMMonth(ctx, now)
	if err != nil {
		return "", nil, nil, err
	}
	price, err := c.Store.LLMPrice(ctx, model)
	if err != nil {
		return "", nil, nil, err
	}
	estimatedCost := int64(0)
	if price != nil {
		estimatedCost = int64(math.Ceil(float64(tokens) * math.Max(price.Input, price.Output)))
	}
	tokenBudget := c.Config.LLMMonthlyTokenBudget

	budgetCost := int64(0)
	if price != nil && c.Config.LLMMonthlyBudgetUSD > 0 {
		budgetCost = int64(c.Config.LLMMonthlyBudgetUSD * 1000000)
	}
	id := rand.Text()
	keys := c.keys(now)
	end := time.Date(now.Year(), now.Month()+1, 1, 0, 0, 0, 0, time.UTC)
	ttl := int64(end.Sub(now).Seconds()) + 86400
	for {
		values, err := acquire.Run(ctx, c.Redis, keys, id, c.Config.LLMConcurrency, (c.Config.LLMTimeout + 30*time.Second).Milliseconds(), totals.Tokens, int64(math.Round(totals.CostUSD*1000000)), tokens, estimatedCost, tokenBudget, budgetCost, c.Config.LLMRPM, ttl).Int64Slice()
		if err != nil {
			return "", nil, nil, err
		}
		if values[0] == 1 {
			return id, keys, price, nil
		}
		if values[0] == -1 {
			_ = c.pause(ctx, "budget")
			return "", nil, nil, llm.ErrPaused
		}
		timer := time.NewTimer(time.Duration(min(values[1], 1000)) * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return "", nil, nil, ctx.Err()
		case <-timer.C:
		}
	}
}
func (c *Client) pause(ctx context.Context, reason string) error {
	if err := c.Redis.Set(ctx, "llm:paused_reason", reason, 32*24*time.Hour).Err(); err != nil {
		return err
	}
	inspector := asynq.NewInspectorFromRedisClient(c.Redis)
	if err := inspector.PauseQueue("llm"); err != nil {
		info, checkErr := inspector.GetQueueInfo("llm")
		if checkErr == nil && info.Paused {
			return nil
		}
		// In v0.26, empty queues are not yet in the queues set, but PauseQueue has already created the pause key.
		paused, checkErr := c.Redis.Exists(ctx, "asynq:{llm}:paused").Result()
		if checkErr == nil && paused == 1 {
			return nil
		}
		return err
	}
	return nil
}
func (c *Client) ConfigureQueue(ctx context.Context) error {
	if c.TranslationConfig != nil {
		cfg, err := c.TranslationConfig(ctx, c.Config)
		if err != nil {
			return err
		}
		snapshot := *c
		snapshot.TranslationConfig = nil
		snapshot.Config.LLMEnabled = c.Config.LLMEnabled || (cfg.LLMEnabled && cfg.LLMAPIKey != "")
		return snapshot.ConfigureQueue(ctx)
	}

	if !c.Config.LLMEnabled {
		reason, err := c.Redis.Get(ctx, "llm:paused_reason").Result()
		if err != nil && !errors.Is(err, redis.Nil) {
			return err
		}
		if reason != "" && reason != "disabled" {
			return nil
		}
		return c.pause(ctx, "disabled")
	}
	reason, err := c.Redis.Get(ctx, "llm:paused_reason").Result()
	if errors.Is(err, redis.Nil) {
		return nil
	}
	if err != nil {
		return err
	}
	if reason == "disabled" {
		inspector := asynq.NewInspectorFromRedisClient(c.Redis)
		if err := inspector.UnpauseQueue("llm"); err != nil {
			return err
		}
		return c.Redis.Del(ctx, "llm:paused_reason").Err()
	}
	return nil
}
func (c *Client) finish(ctx context.Context, id string, keys []string, price *llm.Price, task string, ref int64, usage llm.Usage, requestErr error) error {
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	var totalCost int64
	var result error
	for index, attempt := range usage.Attempts {
		attempt.Result = "succeeded"
		if attempt.FinishReason != "stop" || (index == len(usage.Attempts)-1 && requestErr != nil) {
			attempt.Result = "failed"
		}
		var cost *float64
		if price != nil {
			value := price.Cost(attempt)
			cost = &value
			totalCost += int64(math.Round(value * 1000000))
		}
		result = errors.Join(result, c.Store.SaveLLMUsage(cleanup, task, ref, attempt, cost))
	}
	result = errors.Join(result, settle.Run(cleanup, c.Redis, keys[:3], id, usage.Tokens(), totalCost).Err())
	var failure *llm.Failure
	if errors.As(requestErr, &failure) && failure.Pause {
		result = errors.Join(result, c.pause(cleanup, failure.Reason))
	}
	return result
}
func RetryError(err error) error {
	var failure *llm.Failure
	if errors.As(err, &failure) && !failure.Retryable && !failure.Pause {
		return fmt.Errorf("language request rejected: %w", asynq.SkipRetry)
	}
	if errors.Is(err, llm.ErrPaused) {
		return fmt.Errorf("language queue paused: %w", asynq.SkipRetry)
	}
	return err
}

func (c *Client) TranslateContent(ctx context.Context, in llm.ContentInput) (llm.ContentOutput, llm.Usage, error) {
	if c.TranslationConfig != nil {
		configured, err := c.configuredTranslation(ctx)
		if err != nil {
			return nil, llm.Usage{}, err
		}
		return configured.TranslateContent(ctx, in)
	}
	estimated := int64(18000)
	for _, text := range in.Fields {
		estimated += int64(len(text))
	}
	limited := *c

	if policy, ok := c.Store.(interface {
		ContentBudget(context.Context) (bool, int64, error)
	}); ok {
		enabled, budget, err := policy.ContentBudget(ctx)
		if err != nil {
			return nil, llm.Usage{}, err
		}
		if !enabled {
			return nil, llm.Usage{}, llm.ErrPaused
		}
		limited.Config.LLMMonthlyTokenBudget = budget
		limited.Config.LLMMonthlyBudgetUSD = 0
	}
	id, keys, price, err := limited.reserve(ctx, c.Config.LLMModelTranslate, estimated)
	if err != nil {
		return nil, llm.Usage{}, err
	}
	requestCtx, cancel := context.WithTimeout(ctx, c.Config.LLMTimeout)
	defer cancel()
	out, usage, requestErr := c.Content.TranslateContent(requestCtx, in)
	finishErr := c.finish(ctx, id, keys, price, "translate_content", in.RefID, usage, requestErr)
	return out, usage, errors.Join(requestErr, finishErr)
}

// Each call uses an independent snapshot; in-flight requests stay unchanged and subsequent calls immediately use new configuration.
func (c *Client) configuredTranslation(ctx context.Context) (*Client, error) {
	cfg, err := c.TranslationConfig(ctx, c.Config)
	if err != nil {
		return nil, err
	}
	if !cfg.LLMEnabled || cfg.LLMAPIKey == "" {
		return nil, llm.ErrPaused
	}
	snapshot := *c
	snapshot.Config = cfg
	snapshot.TranslationConfig = nil
	provider := gateway.New(cfg)
	snapshot.Content = provider
	return &snapshot, nil
}
