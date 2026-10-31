package httpserver_test

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	publiccontract "github.com/opennavo/opennavo/server/api"
	"github.com/opennavo/opennavo/server/internal/config"
	httpserver "github.com/opennavo/opennavo/server/internal/http"
	"github.com/stretchr/testify/require"
)

func TestPublicExternalOpenAPIEndpoint(t *testing.T) {
	server, err := httpserver.New(config.Config{WebBaseURL: "http://localhost:3000"}, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	require.NoError(t, err)
	response := httptest.NewRecorder()
	server.Engine.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/openapi.yaml", nil))
	require.Equal(t, http.StatusOK, response.Code)
	require.Equal(t, "application/yaml; charset=utf-8", response.Header().Get("Content-Type"))
	require.Equal(t, "public, max-age=3600", response.Header().Get("Cache-Control"))
	require.Equal(t, string(publiccontract.PublicExternalOpenAPI), response.Body.String())
}
