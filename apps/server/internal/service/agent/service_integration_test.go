//go:build integration

package agent_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/opennavo/opennavo/server/internal/domain"
	"github.com/opennavo/opennavo/server/internal/service/agent"
	"github.com/opennavo/opennavo/server/internal/service/management"
	"github.com/opennavo/opennavo/server/internal/testutil"
	"github.com/stretchr/testify/require"
)

func TestAgentFreshAuthorizationMachineAccountAndAtomicQuota(t *testing.T) {
	ctx := context.Background()
	st := testutil.NewStore(t)
	manager := &management.Service{Store: st}
	created, err := manager.Execute(ctx, "CreateAgentClient", management.Input{Body: map[string]any{"name": "quota-test"}})
	require.NoError(t, err)
	var client struct{ ID, UserID int64 }
	require.NoError(t, json.Unmarshal(created.(json.RawMessage), &client))
	issued, err := manager.Execute(ctx, "CreateAgentToken", management.Input{ID: client.ID, Body: map[string]any{"name": "limited", "permissions": []any{"catalog:package:view", "dashboard:view"}, "ipAllowlist": []any{"127.0.0.1/32"}}})
	require.NoError(t, err)
	token := issued.(map[string]any)["plaintext"].(string)
	svc := &agent.Service{Store: st, GatewaySecret: strings.Repeat("q", 32)}
	identity, err := svc.Authenticate(ctx, svc.GatewaySecret, token, "127.0.0.1")
	require.NoError(t, err)
	require.ElementsMatch(t, []string{"catalog:package:view", "dashboard:view"}, identity.Permissions)
	for _, tc := range []struct{ gateway, token, ip, code string }{
		{"", token, "127.0.0.1", "1004"}, {svc.GatewaySecret, "invalid", "127.0.0.1", "8888"}, {svc.GatewaySecret, token, "192.0.2.1", "1004"},
	} {
		_, err := svc.Authenticate(ctx, tc.gateway, tc.token, tc.ip)
		var app *domain.AppError
		require.True(t, errors.As(err, &app))
		require.Equal(t, tc.code, app.Code)
	}
	require.NoError(t, st.DB.Exec("DELETE FROM admin_role_permissions WHERE permission_code='dashboard:view' AND role_id=(SELECT id FROM admin_roles WHERE role_code='R_AGENT')").Error)
	identity, err = svc.Authenticate(ctx, svc.GatewaySecret, token, "127.0.0.1")
	require.NoError(t, err)
	require.Equal(t, []string{"catalog:package:view"}, identity.Permissions)
	user, err := st.AuthUser(ctx, client.UserID)
	require.NoError(t, err)
	require.True(t, user.IsMachine)
	identity.Limits = agent.Limits{CallsPerMinute: 100, WritesPerDay: 5, LLMOpsPerDay: 3, BatchLimit: 100}
	var succeeded atomic.Int32
	var wg sync.WaitGroup
	for range 20 {
		wg.Go(func() {
			if svc.Reserve(ctx, identity, 1, 1) == nil {
				succeeded.Add(1)
			}
		})
	}
	wg.Wait()
	require.EqualValues(t, 3, succeeded.Load())
	status, err := svc.Introspect(ctx, identity)
	require.NoError(t, err)
	quota := status.(map[string]any)["quota"].(map[string]any)
	require.Equal(t, 0, quota["llmOpsRemaining"])
	require.Equal(t, 2, quota["writesRemaining"])
	for range 2 {
		require.NoError(t, svc.Reserve(ctx, identity, 1, 0))
	}
	require.Error(t, svc.Reserve(ctx, identity, 1, 0))
	require.NoError(t, svc.Reserve(ctx, identity, 0, 0))
	require.NoError(t, st.DB.Exec("UPDATE agent_tokens SET revoked_at=now() WHERE id=?", identity.ID).Error)
	_, err = svc.Authenticate(ctx, svc.GatewaySecret, token, "127.0.0.1")
	var app *domain.AppError
	require.True(t, errors.As(err, &app))
	require.Equal(t, "7777", app.Code)
}
