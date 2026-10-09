//go:build integration

package httpserver_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/opennavo/opennavo/server/gen/adminapi"
	"github.com/opennavo/opennavo/server/internal/config"
	httpserver "github.com/opennavo/opennavo/server/internal/http"
	"github.com/opennavo/opennavo/server/internal/http/admin"
	"github.com/opennavo/opennavo/server/internal/http/middleware"
	"github.com/opennavo/opennavo/server/internal/service/auth"
	"github.com/opennavo/opennavo/server/internal/service/seed"
	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/opennavo/opennavo/server/internal/testutil"
	"github.com/opennavo/opennavo/server/seeds"
	"github.com/stretchr/testify/require"
)

func TestAdminAuthContractsPermissionsRefreshAndStatusCodes(t *testing.T) {
	ctx := context.Background()
	st := testutil.NewStore(t)
	hash, err := seed.HashPassword("test-password-strong")
	require.NoError(t, err)
	seedData, err := seeds.Load()
	require.NoError(t, err)
	require.NoError(t, st.Seed(ctx, seedData, "tester", hash))
	cfg := config.Config{JWTSecret: strings.Repeat("a", 32), JWTAccessTTL: 5 * time.Second, JWTRefreshTTL: 7 * 24 * time.Hour}
	svc, err := auth.New(st, cfg)
	require.NoError(t, err)
	now := time.Now().UTC()
	svc.Now = func() time.Time { return now }
	handler := &admin.Handler{Auth: svc, CIToken: "local-ci-only"}
	server, err := httpserver.New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), st, httpserver.Dependencies{Admin: handler, Rate: &middleware.RateLimiter{Client: st.Redis}})
	require.NoError(t, err)
	spec, err := adminapi.GetSpec()
	require.NoError(t, err)
	call := func(method, path, body, token, code string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(method, "/admin-api"+path, strings.NewReader(body))
		if body != "" {
			request.Header.Set("Content-Type", "application/json")
		}
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		server.Engine.ServeHTTP(w, request)
		testutil.ValidateResponse(t, spec, "/admin-api", request, w)
		require.Equal(t, 200, w.Code)
		var envelope struct{ Code string }
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &envelope))
		require.Equal(t, code, envelope.Code)
		return w
	}
	call("GET", "/auth/getUserInfo", "", "", "8888")
	call("GET", "/auth/getUserInfo", "", "invalid", "8888")
	call("POST", "/auth/login", `{"userName":"tester","password":"wrong"}`, "", "1101")
	var pair struct{ Data adminapi.LoginToken }
	reply := call("POST", "/auth/login", `{"userName":"tester","password":"test-password-strong"}`, "", "0000")
	require.NoError(t, json.Unmarshal(reply.Body.Bytes(), &pair))
	call("GET", "/auth/getUserInfo", "", pair.Data.Token, "0000")
	call("GET", "/profile", "", pair.Data.Token, "0000")
	call("PUT", "/profile", `{"nickName":"测试昵称"}`, pair.Data.Token, "0000")
	call("PUT", "/profile", `{"email":"profile@example.test","avatarUrl":"https://example.test/avatar.png"}`, pair.Data.Token, "0000")
	call("PUT", "/profile", `{"nickName":"只改昵称"}`, pair.Data.Token, "0000")
	var profile struct{ Data adminapi.AdminUser }
	require.NoError(t, json.Unmarshal(call("GET", "/profile", "", pair.Data.Token, "0000").Body.Bytes(), &profile))
	require.Equal(t, "profile@example.test", *profile.Data.Email)
	require.Equal(t, "https://example.test/avatar.png", *profile.Data.AvatarUrl)
	call("PUT", "/profile", `{"email":null}`, pair.Data.Token, "0000")
	profile = struct{ Data adminapi.AdminUser }{}
	require.NoError(t, json.Unmarshal(call("GET", "/profile", "", pair.Data.Token, "0000").Body.Bytes(), &profile))
	require.Nil(t, profile.Data.Email)
	require.NotNil(t, profile.Data.AvatarUrl)
	call("PUT", "/profile", `{"avatarUrl":null}`, pair.Data.Token, "0000")
	profile = struct{ Data adminapi.AdminUser }{}
	require.NoError(t, json.Unmarshal(call("GET", "/profile", "", pair.Data.Token, "0000").Body.Bytes(), &profile))
	require.Nil(t, profile.Data.Email)
	require.Nil(t, profile.Data.AvatarUrl)

	now = now.Add(4 * time.Second)
	call("GET", "/auth/getUserInfo", "", pair.Data.Token, "0000")
	now = now.Add(2 * time.Second)
	call("GET", "/auth/getUserInfo", "", pair.Data.Token, "9999")
	body, _ := json.Marshal(adminapi.RefreshTokenRequest{RefreshToken: pair.Data.RefreshToken}) //nolint:gosec // Tokens are sent only to the temporary test service to verify refresh, never printed or saved.
	reply = call("POST", "/auth/refreshToken", string(body), "", "0000")
	var rotated struct{ Data adminapi.LoginToken }
	require.NoError(t, json.Unmarshal(reply.Body.Bytes(), &rotated))
	call("GET", "/auth/getUserInfo", "", rotated.Data.Token, "0000")
	call("POST", "/auth/refreshToken", string(body), "", "7777")
	call("POST", "/auth/refreshToken", `{"refreshToken":"invalid"}`, "", "8888")
	pair.Data, err = svc.Login(ctx, "tester", "test-password-strong", store.AuditActor{})
	require.NoError(t, err)
	id, err := svc.Authenticate(ctx, pair.Data.Token)
	require.NoError(t, err)
	require.NoError(t, st.DB.WithContext(ctx).Exec("UPDATE admin_users SET status='2' WHERE id=?", id.ID).Error)
	call("GET", "/auth/getUserInfo", "", pair.Data.Token, "8889")
	require.NoError(t, st.DB.WithContext(ctx).Exec("UPDATE admin_users SET status='1',session_version=session_version+1 WHERE id=?", id.ID).Error)
	call("GET", "/auth/getUserInfo", "", pair.Data.Token, "7778")
	require.NoError(t, st.DB.WithContext(ctx).Exec(`DELETE FROM admin_user_roles WHERE user_id=?`, id.ID).Error)
	require.NoError(t, st.DB.WithContext(ctx).Exec(`INSERT INTO admin_user_roles(user_id,role_id) SELECT ?,id FROM admin_roles WHERE role_code='R_REVIEWER'`, id.ID).Error)
	pair.Data, err = svc.Login(ctx, "tester", "test-password-strong", store.AuditActor{})
	require.NoError(t, err)
	call("GET", "/system/users", "", pair.Data.Token, "1004")
	call("GET", "/auth/getUserInfo", "", pair.Data.Token, "0000")
	call("GET", "/auth/getUserInfo", "", "local-ci-only", "1004")
	call("PUT", "/profile/password", `{"oldPassword":"test-password-strong","newPassword":"another-test-password"}`, pair.Data.Token, "0000")
	call("GET", "/auth/getUserInfo", "", pair.Data.Token, "7778")
	require.NoError(t, st.Redis.Set(ctx, "rate:admin:login:192.0.2.1", now.Add(24*time.Hour).UnixMicro(), time.Hour).Err())
	call("POST", "/auth/login", `{"userName":"missing","password":"wrong"}`, "", "1005")
	require.NoError(t, st.Redis.Del(ctx, "rate:admin:login:192.0.2.1").Err())
	require.NotEmpty(t, strconv.FormatInt(id.ID, 10))
}
