package openai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"

	sdk "github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/option"
	"github.com/opennavo/opennavo/server/internal/config"
	"github.com/opennavo/opennavo/server/internal/llm"
)

type Client struct {
	client sdk.Client
	cfg    config.Config
}

func New(cfg config.Config, options ...option.RequestOption) *Client {
	opts := []option.RequestOption{option.WithBaseURL(cfg.LLMBaseURL), option.WithAPIKey(cfg.LLMAPIKey), option.WithRequestTimeout(cfg.LLMTimeout), option.WithMaxRetries(2)}
	opts = append(opts, options...)
	return &Client{client: sdk.NewClient(opts...), cfg: cfg}
}

func decode(content string, out any, required []string) error {
	var fields map[string]json.RawMessage
	if json.Unmarshal([]byte(content), &fields) != nil {
		return &llm.Failure{Reason: "invalid_json"}
	}
	for _, key := range required {
		if _, ok := fields[key]; !ok {
			return &llm.Failure{Reason: "missing_field"}
		}
		if string(fields[key]) == "null" {
			return &llm.Failure{Reason: "invalid_schema"}
		}
	}
	decoder := json.NewDecoder(bytes.NewBufferString(content))
	decoder.DisallowUnknownFields()
	if decoder.Decode(out) != nil {
		return &llm.Failure{Reason: "invalid_schema"}
	}
	if decoder.Decode(new(any)) != io.EOF {
		return &llm.Failure{Reason: "invalid_json"}
	}
	return nil
}
func classify(err error) *llm.Failure {
	var apiErr *sdk.Error
	if errors.As(err, &apiErr) {
		switch apiErr.StatusCode {
		case 400:
			return &llm.Failure{Reason: "invalid_request"}
		case 401, 403:
			return &llm.Failure{Reason: "authorization", Pause: true}
		case 429:
			return &llm.Failure{Reason: "rate_limited", Retryable: true}
		default:
			if apiErr.StatusCode >= 500 {
				return &llm.Failure{Reason: "upstream_error", Retryable: true}
			}
		}
	}
	if errors.Is(err, context.Canceled) {
		return &llm.Failure{Reason: "canceled", Retryable: true}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return &llm.Failure{Reason: "timeout", Retryable: true}
	}
	return &llm.Failure{Reason: "transport", Retryable: true}
}

func (c *Client) translationEffort() string {
	if c.cfg.LLMReasoningEffortTranslate == "" {
		return "medium"
	}
	return c.cfg.LLMReasoningEffortTranslate
}
