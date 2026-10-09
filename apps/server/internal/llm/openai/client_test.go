package openai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/openai/openai-go/v3/option"
	"github.com/opennavo/opennavo/server/internal/config"
	"github.com/opennavo/opennavo/server/internal/llm"
	"github.com/stretchr/testify/require"
)

func testClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return New(config.Config{LLMBaseURL: server.URL + "/v1", LLMAPIKey: "fake-local-value", LLMTimeout: time.Second, LLMModelTranslate: "gpt-6-luna", LLMReasoningEffortTranslate: "high"}, option.WithMaxRetries(0))
}

const contentResponse = `{"ja-JP":{"title":"ファイルを管理するアプリです"}}`

func completion(content, finish string) string {
	value, _ := json.Marshal(content)
	return fmt.Sprintf(`{"choices":[{"finish_reason":%q,"message":{"role":"assistant","content":%s}}],"usage":{"prompt_tokens":100,"completion_tokens":50,"completion_tokens_details":{"reasoning_tokens":20},"prompt_tokens_details":{"cached_tokens":30}}}`, finish, value)
}
func TestSDKRejectsMalformedContentAndClassifiesErrors(t *testing.T) {
	for _, example := range []struct {
		name, content, finish string
		status                int
		retry, pause          bool
	}{{"invalid-json", "bad", "stop", 200, false, false}, {"missing", "{}", "stop", 200, false, false}, {"unknown-field", strings.TrimSuffix(contentResponse, "}") + `,"extra":true}`, "stop", 200, false, false}, {"filter", "", "content_filter", 200, false, false}, {"length", "", "length", 200, false, false}, {"bad-request", "", "", 400, false, false}, {"credentials", "", "", 401, false, true}, {"forbidden", "", "", 403, false, true}, {"rate", "", "", 429, true, false}, {"upstream", "", "", 503, true, false}} {
		t.Run(example.name, func(t *testing.T) {
			client := testClient(t, func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(example.status)
				body := completion(example.content, example.finish)
				if example.status != 200 {
					body = `{"error":{"message":"private-value","type":"test","code":"test"}}`
				}
				_, _ = w.Write([]byte(body))
			})
			_, usage, err := client.TranslateContent(context.Background(), llm.ContentInput{SourceLocale: "en-US", Targets: []string{"ja-JP"}, Fields: map[string]string{"title": "The application manages files"}})
			require.Error(t, err)
			require.NotEmpty(t, usage.Attempts)
			var failure *llm.Failure
			require.True(t, errors.As(err, &failure))
			require.Equal(t, example.retry, failure.Retryable)
			require.Equal(t, example.pause, failure.Pause)
			require.NotContains(t, err.Error(), "private-value")
		})
	}
}
