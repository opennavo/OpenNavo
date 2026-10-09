package management

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/opennavo/opennavo/server/internal/config"
	"github.com/opennavo/opennavo/server/internal/domain"
	"github.com/stretchr/testify/require"
)

func TestTranslationModelsFiltersAndSanitizesGatewayFailures(t *testing.T) {
	for _, tc := range []struct {
		name, response string
		status         int
		success        bool
	}{
		{"sorted-deduplicated", `{"data":[{"id":"z"},{"id":"a"},{"id":"z"},{"id":"bad model"},{"id":"unit-secret"},{"id":""}]}`, 200, true},
		{"empty", `{"data":[]}`, 200, true},
		{"missing-list", `{}`, 200, false},
		{"null-list", `{"data":null}`, 200, false},
		{"malformed", `not-json-unit-secret`, 200, false},
		{"unauthorized", `{"error":{"message":"unit-secret"}}`, 401, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				require.Equal(t, "/v1/models", r.URL.Path)
				require.Equal(t, "GET", r.Method)
				require.Equal(t, "Bearer unit-secret", r.Header.Get("Authorization"))
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.response)
			}))
			defer gateway.Close()
			svc := &Service{Config: config.Config{AppEnv: "dev"}}
			out, err := svc.translationModels(context.Background(), Input{Body: map[string]any{"baseUrl": gateway.URL + "/v1", "apiKey": "unit-secret"}})
			require.Equal(t, 1, calls)
			if tc.success {
				require.NoError(t, err)
				if tc.name == "empty" {
					require.Empty(t, out.(map[string]any)["models"])
				} else {
					require.Equal(t, []string{"a", "z"}, out.(map[string]any)["models"])
				}
			} else {
				var app *domain.AppError
				require.ErrorAs(t, err, &app)
				require.Equal(t, domain.CodeLLMUnavailable, app.Code)
				require.NotContains(t, err.Error(), "unit-secret")
				require.Nil(t, app.Cause)
			}
		})
	}
}

func TestTranslationModelsNeverFollowsRedirects(t *testing.T) {
	forwarded := false
	target := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) { forwarded = true }))
	defer target.Close()
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer gateway.Close()
	svc := &Service{Config: config.Config{AppEnv: "dev"}}
	_, err := svc.translationModels(context.Background(), Input{Body: map[string]any{"baseUrl": gateway.URL, "apiKey": "unit-secret"}})
	require.Error(t, err)
	require.False(t, forwarded)
}
