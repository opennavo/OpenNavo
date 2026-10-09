//go:build integration

package httpserver_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/opennavo/opennavo/server/gen/adminapi"
	"github.com/opennavo/opennavo/server/internal/config"
	httpserver "github.com/opennavo/opennavo/server/internal/http"
	"github.com/opennavo/opennavo/server/internal/http/admin"
	"github.com/opennavo/opennavo/server/internal/llm"
	"github.com/opennavo/opennavo/server/internal/llm/control"
	"github.com/opennavo/opennavo/server/internal/service/auth"
	"github.com/opennavo/opennavo/server/internal/service/management"
	"github.com/opennavo/opennavo/server/internal/service/seed"
	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/opennavo/opennavo/server/internal/testutil"
	"github.com/opennavo/opennavo/server/seeds"
	"github.com/stretchr/testify/require"
)

func TestTranslationSettingsContractSecretsAndLiveReconfiguration(t *testing.T) {
	ctx := context.Background()
	st := testutil.NewStore(t)
	data, err := seeds.Load()
	require.NoError(t, err)
	hash, err := seed.HashPassword("isolated-test-password")
	require.NoError(t, err)
	require.NoError(t, st.Seed(ctx, data, "settings_tester", hash))
	calls := 0
	modelKeys := []string{}
	modelsFail := false
	model, effort, key := "first-model", "low", "admin-credential-one"
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/models" {
			modelKeys = append(modelKeys, r.Header.Get("Authorization"))
			w.Header().Set("Content-Type", "application/json")
			if modelsFail {
				w.WriteHeader(401)
				_, _ = io.WriteString(w, `{"error":{"message":"admin-credential-secret-echo"}}`)
				return
			}
			_, _ = io.WriteString(w, `{"object":"list","data":[{"id":"z-model"},{"id":"a-model"},{"id":"z-model"}]}`)
			return
		}
		calls++
		require.Equal(t, "Bearer "+key, r.Header.Get("Authorization"))
		var payload map[string]any
		require.NoError(t, json.NewDecoder(r.Body).Decode(&payload))
		require.Equal(t, model, payload["model"])
		require.Equal(t, effort, payload["reasoning_effort"])
		require.Equal(t, "/v1/chat/completions", r.URL.Path)
		content := `{"ja-JP":{"title":"ファイルを管理するアプリです"}}`
		if format, ok := payload["response_format"].(map[string]any); ok {
			schema, _ := format["json_schema"].(map[string]any)
			if schema["name"] == "release_summary" {
				content = `{"isEmpty":false,"summary":"Improved file management","sections":[],"bodyMarkdown":""}`
			}
		}
		w.Header().Set("Content-Type", "application/json")
		require.NoError(t, json.NewEncoder(w).Encode(map[string]any{"id": "unit", "object": "chat.completion", "model": model, "choices": []any{map[string]any{"index": 0, "finish_reason": "stop", "message": map[string]any{"role": "assistant", "content": content}}}, "usage": map[string]any{"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}))
	}))
	defer gateway.Close()
	cfg := config.Config{AppEnv: "dev", JWTSecret: strings.Repeat("a", 32), JWTAccessTTL: 2 * time.Hour, JWTRefreshTTL: 7 * 24 * time.Hour, LLMBaseURL: gateway.URL + "/v1", LLMAPIKey: "environment-credential", LLMModelTranslate: "environment-model", LLMTimeout: time.Second, LLMConcurrency: 2, LLMRPM: 120, LLMMonthlyTokenBudget: 1, LLMMonthlyBudgetUSD: 0.000001}
	authentication, err := auth.New(st, cfg)
	require.NoError(t, err)
	pair, err := authentication.Login(ctx, "settings_tester", "isolated-test-password", store.AuditActor{})
	require.NoError(t, err)
	svc := &management.Service{Store: st, Config: cfg}
	app, err := httpserver.New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), st, httpserver.Dependencies{Admin: &admin.Handler{Auth: authentication, Management: svc}})
	require.NoError(t, err)
	spec, err := adminapi.GetSpec()
	require.NoError(t, err)
	callPath := func(path, method string, body map[string]any, success bool) map[string]any {
		t.Helper()
		var content []byte
		if body != nil {
			content, err = json.Marshal(body)
			require.NoError(t, err)
		}
		req := httptest.NewRequest(method, path, strings.NewReader(string(content)))
		req.Header.Set("Authorization", "Bearer "+pair.Token)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		app.Engine.ServeHTTP(rec, req)
		require.Equal(t, 200, rec.Code)
		require.NotContains(t, rec.Body.String(), "admin-credential")
		require.NotContains(t, rec.Body.String(), "environment-credential")
		var envelope struct {
			Code string         `json:"code"`
			Data map[string]any `json:"data"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &envelope))
		if success {
			require.Equal(t, "0000", envelope.Code)

		} else {
			require.NotEqual(t, "0000", envelope.Code)
		}
		testutil.ValidateResponse(t, spec, "/admin-api", req, rec)
		return envelope.Data
	}
	call := func(method string, body map[string]any, success bool) map[string]any {
		return callPath("/admin-api/system/translation-settings", method, body, success)
	}
	models := func(body map[string]any, success bool) map[string]any {
		return callPath("/admin-api/system/translation-settings/models", "POST", body, success)
	}
	lookup := map[string]any{"baseUrl": gateway.URL + "/v1"}
	require.Equal(t, []any{"a-model", "z-model"}, models(lookup, true)["models"])
	require.Equal(t, "Bearer environment-credential", modelKeys[len(modelKeys)-1])
	initial := call("GET", nil, true)
	require.Equal(t, "environment", initial["apiKeySource"])
	body := map[string]any{"enabled": true, "baseUrl": gateway.URL + "/v1", "model": model, "reasoningEffort": effort, "monthlyTokenBudget": float64(100000), "apiKey": key}
	saved := call("PUT", body, true)
	require.Equal(t, "admin", saved["apiKeySource"])
	require.Equal(t, true, saved["environmentKeyConfigured"])
	settings, err := st.TranslationSettings(ctx)
	require.NoError(t, err)
	encrypted := settings.APIKeyCiphertext
	require.Equal(t, []any{"a-model", "z-model"}, models(lookup, true)["models"])
	require.Equal(t, "Bearer "+key, modelKeys[len(modelKeys)-1])
	lookup["apiKey"] = "unsaved-admin-credential"
	models(lookup, true)
	require.Equal(t, "Bearer unsaved-admin-credential", modelKeys[len(modelKeys)-1])
	afterLookup, err := st.TranslationSettings(ctx)
	require.NoError(t, err)
	require.Equal(t, settings, afterLookup)
	lookup["apiKey"] = ""
	lookup["clearApiKey"] = true
	models(lookup, true)
	require.Equal(t, "Bearer environment-credential", modelKeys[len(modelKeys)-1])
	lookup["clearApiKey"] = false
	modelsFail = true
	models(lookup, false)
	modelsFail = false
	require.NotContains(t, encrypted, key)
	controlled := &control.Client{Store: st, Redis: st.Redis, Config: cfg, TranslationConfig: st.TranslationConfig}
	require.NoError(t, controlled.ConfigureQueue(ctx))
	input := llm.ContentInput{SourceLocale: "en-US", Targets: []string{"ja-JP"}, Fields: map[string]string{"title": "The application manages your files"}}
	_, usage, err := controlled.TranslateContent(ctx, input)
	require.NoError(t, err)
	require.Equal(t, model, usage.Attempts[0].Model)
	require.Equal(t, effort, usage.Attempts[0].ReasoningEffort)
	require.NoError(t, st.Redis.Set(ctx, "llm:paused_reason", "authorization", time.Minute).Err())
	require.NoError(t, st.Redis.Set(ctx, "asynq:{llm}:paused", "1", 0).Err())
	model, effort, key = "second-model", "high", "admin-credential-two"
	body["model"], body["reasoningEffort"], body["apiKey"] = model, effort, key
	call("PUT", body, true)
	paused, err := st.Redis.Exists(ctx, "llm:paused_reason", "asynq:{llm}:paused").Result()
	require.NoError(t, err)
	require.Zero(t, paused)
	_, _, err = controlled.TranslateContent(ctx, input)
	require.NoError(t, err)
	body["apiKey"] = ""
	call("PUT", body, true)
	settings, err = st.TranslationSettings(ctx)
	require.NoError(t, err)
	require.NotEqual(t, encrypted, settings.APIKeyCiphertext)
	decrypted, err := cfg.DecryptTranslationKey(settings.APIKeyCiphertext)
	require.NoError(t, err)
	require.Equal(t, key, decrypted)
	body["monthlyTokenBudget"] = float64(30000001)
	updated := call("PUT", body, true)
	require.Equal(t, float64(30000001), updated["monthlyTokenBudget"])
	effective, err := st.TranslationConfig(ctx, cfg)
	require.NoError(t, err)
	require.Equal(t, int64(30000001), effective.LLMMonthlyTokenBudget)
	require.Zero(t, effective.LLMMonthlyBudgetUSD)
	body["monthlyTokenBudget"] = float64(100000)
	body["baseUrl"] = gateway.URL + "/v1?key=private"
	call("PUT", body, false)
	body["baseUrl"] = gateway.URL + "/v1"
	body["clearApiKey"] = true
	cleared := call("PUT", body, true)
	require.Equal(t, "environment", cleared["apiKeySource"])
	key = "environment-credential"
	_, _, err = controlled.TranslateContent(ctx, input)
	require.NoError(t, err)
	body["monthlyTokenBudget"] = float64(1)
	call("PUT", body, true)
	_, _, err = controlled.TranslateContent(ctx, input)
	require.ErrorIs(t, err, llm.ErrPaused)
	body["monthlyTokenBudget"] = float64(100000)
	body["enabled"] = false
	call("PUT", body, true)
	_, _, err = controlled.TranslateContent(ctx, input)
	require.ErrorIs(t, err, llm.ErrPaused)
	require.Equal(t, 3, calls)
	var audit string
	require.NoError(t, st.DB.Raw("SELECT string_agg(coalesce(before::text,'')||coalesce(after::text,''),'') FROM audit_logs WHERE entity_type='i18n_settings'").Scan(&audit).Error)
	require.NotContains(t, audit, "admin-credential")
	require.NotContains(t, audit, "environment-credential")
	require.NotContains(t, audit, encrypted)
}
