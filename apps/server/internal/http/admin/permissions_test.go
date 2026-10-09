package admin

import (
	"strings"
	"testing"

	"github.com/opennavo/opennavo/server/gen/adminapi"
	"github.com/opennavo/opennavo/server/seeds"
	"github.com/stretchr/testify/require"
)

func TestPermissionsCoverEveryProtectedContractRoute(t *testing.T) {
	spec, err := adminapi.GetSpec()
	require.NoError(t, err)
	data, err := seeds.Load()
	require.NoError(t, err)
	known := map[string]bool{"": true}
	for _, p := range data.Permissions {
		known[p.Code] = true
	}
	for path, item := range spec.Paths.Map() {
		segments := strings.Split(path, "/")
		for i, s := range segments {
			if strings.HasPrefix(s, "{") {
				segments[i] = ":" + strings.Trim(s, "{}")
			}
		}
		for method, op := range item.Operations() {
			if strings.EqualFold(op.OperationID, "login") || strings.EqualFold(op.OperationID, "refreshToken") {
				continue
			}
			key := method + " /admin-api" + strings.Join(segments, "/")
			code, ok := Permissions[key]
			require.True(t, ok, key)
			require.True(t, known[code], code)
		}
	}
	_, ok := Permissions["DELETE /admin-api/unknown"]
	require.False(t, ok)
}
