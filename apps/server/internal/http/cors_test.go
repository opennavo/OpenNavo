package httpserver_test

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/opennavo/opennavo/server/internal/config"
	httpserver "github.com/opennavo/opennavo/server/internal/http"
	"github.com/opennavo/opennavo/server/internal/http/middleware"
	"github.com/stretchr/testify/require"
)

func TestCORSPreflightRunsBeforeContractAndRateLimiting(t *testing.T) {
	server, err := httpserver.New(config.Config{AppEnv: "dev", WebBaseURL: "https://opennavo.example", AdminOrigin: "https://admin.opennavo.example"}, slog.New(slog.NewTextHandler(io.Discard, nil)), readiness{}, httpserver.Dependencies{Rate: &middleware.RateLimiter{}})
	require.NoError(t, err)
	for _, origin := range []string{"tauri://localhost", "http://tauri.localhost", "http://localhost:3000", "http://localhost:1420"} {
		request := httptest.NewRequest("OPTIONS", "/api/v1/home", nil)
		request.Header.Set("Origin", origin)
		request.Header.Set("Access-Control-Request-Method", "GET")
		request.Header.Set("Access-Control-Request-Headers", "x-client-platform,x-client-version,x-request-id")
		reply := httptest.NewRecorder()
		server.Engine.ServeHTTP(reply, request)
		require.Equal(t, http.StatusNoContent, reply.Code, "preflight must not reach the missing Redis client")
		require.Equal(t, origin, reply.Header().Get("Access-Control-Allow-Origin"))
	}
}
