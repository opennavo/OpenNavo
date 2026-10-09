package openai

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/opennavo/opennavo/server/internal/llm"
	"github.com/stretchr/testify/require"
)

func TestContentSDKConfiguredEffortStrictAndNoHiddenRetries(t *testing.T) {
	calls := 0
	status := 200
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		var body struct {
			Reasoning string          `json:"reasoning_effort"`
			Format    json.RawMessage `json:"response_format"`
		}
		require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
		require.Equal(t, "high", body.Reasoning)
		require.Contains(t, string(body.Format), `"strict":true`)
		require.Contains(t, string(body.Format), `"ja-JP"`)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		if status == 200 {
			_, _ = w.Write([]byte(completion(`{"ja-JP":{"title":"ファイルを管理するアプリです"}}`, "stop")))
		} else {
			_, _ = w.Write([]byte(`{"error":{"message":"private-gateway-response"}}`))
		}
	})
	in := llm.ContentInput{SourceLocale: "en-US", Targets: []string{"ja-JP"}, Fields: map[string]string{"title": "The application manages your files"}}
	_, usage, err := client.TranslateContent(context.Background(), in)
	require.NoError(t, err)
	require.EqualValues(t, 150, usage.Tokens())
	require.Equal(t, 1, calls)
	status = 503
	_, usage, err = client.TranslateContent(context.Background(), in)
	require.Error(t, err)
	require.NotContains(t, err.Error(), "private-gateway-response")
	require.Len(t, usage.Attempts, 1)
	require.Equal(t, 2, calls)
}

func TestContentCodeFencesRoundTripWithoutSendingCode(t *testing.T) {
	const block = "```sh\nbrew install --cask orbit\n```"
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
		var input llm.ContentInput
		require.NoError(t, json.Unmarshal([]byte(body.Messages[1].Content), &input))
		require.NotContains(t, input.Fields["body"], "brew install")
		require.Contains(t, input.Fields["body"], "{{ONV_LITERAL_0}}_")
		out, err := json.Marshal(llm.ContentOutput{"ja-JP": {"body": "アプリをインストールします。\n\n{{ONV_LITERAL_0}}_", "note": "設定には {{ONV_LITERAL_0}} を使います。"}})
		require.NoError(t, err)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(completion(string(out), "stop")))
	})
	input := llm.ContentInput{SourceLocale: "en-US", Targets: []string{"ja-JP"}, Fields: map[string]string{"body": "Install the application.\n\n" + block, "note": "Use {{ONV_LITERAL_0}} in settings."}}
	out, _, err := client.TranslateContent(context.Background(), input)
	require.NoError(t, err)
	require.Contains(t, out["ja-JP"]["body"], block)
	require.Contains(t, out["ja-JP"]["note"], "{{ONV_LITERAL_0}}")
	require.NotContains(t, out["ja-JP"]["note"], block)
}
