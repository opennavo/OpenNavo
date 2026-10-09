package auth

import (
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/opennavo/opennavo/server/internal/config"
	"github.com/opennavo/opennavo/server/internal/service/seed"
	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/stretchr/testify/require"
)

func TestStrictPasswordAndAccessClaims(t *testing.T) {
	hash, err := seed.HashPassword("test-password-strong")
	require.NoError(t, err)
	require.True(t, VerifyPassword("test-password-strong", hash))
	require.False(t, VerifyPassword("wrong", hash))
	for _, h := range []string{"invalid", strings.Replace(hash, "m=65536", "m=999999999", 1), strings.Replace(hash, "$v=19", "$v=16", 1), strings.TrimSuffix(hash, "=") + "!"} {
		require.False(t, VerifyPassword("test-password-strong", h))
	}
	now := time.Now().UTC()
	svc, err := New(nil, config.Config{JWTSecret: strings.Repeat("a", 32), JWTAccessTTL: 2 * time.Hour, JWTRefreshTTL: 7 * 24 * time.Hour})
	require.NoError(t, err)
	svc.Now = func() time.Time { return now }
	token, err := svc.sign(store.AuthUser{ID: 7, UserName: "tester", SessionVersion: 2}, 11)
	require.NoError(t, err)
	claims, err := svc.Parse(token)
	require.NoError(t, err)
	require.Equal(t, "7", claims.Subject)
	require.Equal(t, "11", claims.ID)
	require.Equal(t, 2, claims.SV)
	svc.Now = func() time.Time { return now.Add(3 * time.Hour) }
	_, err = svc.Parse(token)
	require.ErrorContains(t, err, "9999")
	_, err = svc.Parse(token + "x")
	require.ErrorContains(t, err, "8888")
	_, err = svc.Parse("invalid")
	require.ErrorContains(t, err, "8888")
	_, err = svc.Parse(strings.Repeat("a", 8193))
	require.ErrorContains(t, err, "8888")
	claims.Type = "refresh"
	other, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(svc.Config.JWTSecret))
	require.NoError(t, err)
	_, err = svc.Parse(other)
	require.ErrorContains(t, err, "8888")
	require.Equal(t, "x", Bearer("Bearer x"))
	require.Equal(t, "", Bearer("x"))
	require.True(t, (Identity{Permissions: store.PermissionSet{Roles: []string{"R_SUPER"}}}).Allowed("permission"))
	require.False(t, (Identity{}).Allowed("permission"))
	_, err = New(nil, config.Config{})
	require.Error(t, err)
}
