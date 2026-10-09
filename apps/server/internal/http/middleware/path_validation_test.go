package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/opennavo/opennavo/server/gen/publicapi"
	"github.com/stretchr/testify/require"
)

func TestValidationDecodesPackagePathExactlyOnce(t *testing.T) {
	gin.SetMode(gin.ReleaseMode)
	spec, err := publicapi.GetSpec()
	require.NoError(t, err)
	validate, err := Validate(spec, "/api/v1", false)
	require.NoError(t, err)
	router := gin.New()
	router.GET("/api/v1/packages/:kind/:token", validate, func(c *gin.Context) { c.String(http.StatusOK, c.Param("token")) })
	for _, tc := range []struct {
		token, want string
		status      int
	}{
		{"ableton-live-standard@11", "ableton-live-standard@11", 200},
		{"ableton-live-standard%4011", "ableton-live-standard@11", 200},
		{"foo%2Bbar", "foo+bar", 200},
		{"foo+bar", "foo+bar", 200},
		{"foo%254011", "", 400},
		{"foo%20bar", "", 400},
	} {
		t.Run(tc.token, func(t *testing.T) {
			w := httptest.NewRecorder()
			router.ServeHTTP(w, httptest.NewRequest("GET", "/api/v1/packages/cask/"+tc.token, nil))
			require.Equal(t, tc.status, w.Code, w.Body.String())
			if tc.status == 200 {
				require.Equal(t, tc.want, w.Body.String())
			}
		})
	}
}
