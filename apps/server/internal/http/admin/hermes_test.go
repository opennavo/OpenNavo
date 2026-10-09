package admin

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/opennavo/opennavo/server/gen/adminapi"
	"github.com/opennavo/opennavo/server/internal/domain"
	"github.com/opennavo/opennavo/server/seeds"
	"github.com/stretchr/testify/require"
)

func TestHermesAdminIntrospectionAlwaysDenied(t *testing.T) {
	h := &Handler{}
	// Always reject the admin path, independently of valid accounts, CI tokens or the Auth service.
	r := gin.New()
	r.Use(h.Middleware(nil))
	r.POST("/admin-api/introspect", func(c *gin.Context) { t.Error("introspection reached handler") })
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/admin-api/introspect", nil))
	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Body.String(), `"code":"1004"`)
	_, err := h.IntrospectAgentToken(context.Background(), adminapi.IntrospectAgentTokenRequestObject{})
	var appError *domain.AppError
	require.ErrorAs(t, err, &appError)
	require.Equal(t, domain.CodeForbidden, appError.Code)
}

func TestHermesAgentSeedExactlyMatchesGrantableContract(t *testing.T) {
	spec, err := adminapi.GetSpec()
	require.NoError(t, err)
	seed, err := seeds.Load()
	require.NoError(t, err)
	var granted []any
	for _, permission := range seed.Permissions {
		for _, role := range permission.Roles {
			if role == "R_AGENT" {
				granted = append(granted, permission.Code)
			}
		}
	}
	require.Len(t, granted, 21)
	require.ElementsMatch(t, spec.Components.Schemas["AgentPermission"].Value.Enum, granted)
}

func TestAgentRouteWhitelistCountAndForbiddenSurfaces(t *testing.T) {
	spec, err := adminapi.GetSpec()
	require.NoError(t, err)
	policies := AgentPolicies(spec)
	require.Len(t, policies, 79)
	require.Contains(t, policies, "POST /introspect")
	require.Equal(t, []string{"dashboard:view"}, policies["GET /dashboard/llm-usage"].Permissions)
	for _, key := range []string{"GET /app-config", "PUT /app-config/:key", "GET /mirrors", "POST /desktop-releases", "PUT /desktop-releases/:id", "POST /desktop-releases/:id/publish", "POST /desktop-releases/:id/rollback", "POST /agent/clients", "GET /system/users"} {
		require.NotContains(t, policies, key)
	}
	require.Equal(t, []string{"release:desktop:notes"}, policies["GET /desktop-releases"].Permissions)
}
