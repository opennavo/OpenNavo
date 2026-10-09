package middleware

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestRequestLogOmitsClientAddress(t *testing.T) {
	gin.SetMode(gin.ReleaseMode)
	var output bytes.Buffer
	router := gin.New()
	require.NoError(t, router.SetTrustedProxies([]string{"192.0.2.0/24"}))
	router.Use(RequestID(), Logger(slog.New(slog.NewJSONHandler(&output, nil))))
	router.GET("/packages/:name", func(c *gin.Context) { c.Status(http.StatusOK) })
	request := httptest.NewRequest(http.MethodGet, "/packages/example?private=secret", nil)
	request.RemoteAddr = "192.0.2.10:12345"
	request.Header.Set("X-Forwarded-For", "198.51.100.42")
	request.Header.Set("X-Request-ID", "privacy-regression")
	router.ServeHTTP(httptest.NewRecorder(), request)
	var entry map[string]any
	require.NoError(t, json.Unmarshal(output.Bytes(), &entry))
	require.Equal(t, "/packages/:name", entry["route"])
	require.Equal(t, float64(200), entry["status"])
	require.Equal(t, "privacy-regression", entry["requestId"])
	require.Contains(t, entry, "latencyMs")
	require.NotContains(t, entry, "ip")
	for _, private := range []string{"192.0.2.10", "198.51.100.42", "secret"} {
		require.NotContains(t, output.String(), private)
	}
}
