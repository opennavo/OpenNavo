//go:build integration

package httpserver_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/opennavo/opennavo/server/gen/adminapi"
	"github.com/opennavo/opennavo/server/internal/changelog"
	"github.com/opennavo/opennavo/server/internal/config"
	httpserver "github.com/opennavo/opennavo/server/internal/http"
	"github.com/opennavo/opennavo/server/internal/http/admin"
	"github.com/opennavo/opennavo/server/internal/service/auth"
	"github.com/opennavo/opennavo/server/internal/service/management"
	"github.com/opennavo/opennavo/server/internal/service/seed"
	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/opennavo/opennavo/server/internal/testutil"
	"github.com/opennavo/opennavo/server/seeds"
	"github.com/stretchr/testify/require"
)

type githubRoundTrip func(*http.Request) (*http.Response, error)

func (f githubRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestGitHubSettingsContractSecretsAndLiveReconfiguration(t *testing.T) {
	// A stale process environment token must never serve as fallback when the admin PAT is unset or cleared.
	t.Setenv("GITHUB_TOKEN", "ignored-environment-github-credential")
	ctx := context.Background()
	st := testutil.NewStore(t)
	data, err := seeds.Load()
	require.NoError(t, err)
	hash, err := seed.HashPassword("isolated-test-password")
	require.NoError(t, err)
	require.NoError(t, st.Seed(ctx, data, "github_tester", hash))
	cfg := config.Config{AppEnv: "dev", JWTSecret: strings.Repeat("a", 32), JWTAccessTTL: time.Hour, JWTRefreshTTL: 24 * time.Hour}
	authentication, err := auth.New(st, cfg)
	require.NoError(t, err)
	pair, err := authentication.Login(ctx, "github_tester", "isolated-test-password", store.AuditActor{})
	require.NoError(t, err)
	svc := &management.Service{Store: st, Config: cfg}
	var logs bytes.Buffer
	app, err := httpserver.New(cfg, slog.New(slog.NewTextHandler(&logs, nil)), st, httpserver.Dependencies{Admin: &admin.Handler{Auth: authentication, Management: svc}})
	require.NoError(t, err)
	spec, err := adminapi.GetSpec()
	require.NoError(t, err)
	call := func(method string, body map[string]any, code string) map[string]any {
		t.Helper()
		var raw []byte
		if body != nil {
			raw, err = json.Marshal(body)
			require.NoError(t, err)
		}
		req := httptest.NewRequest(method, "/admin-api/system/github-settings", bytes.NewReader(raw))
		req.Header.Set("Authorization", "Bearer "+pair.Token)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		app.Engine.ServeHTTP(rec, req)
		require.Equal(t, 200, rec.Code)
		require.NotContains(t, rec.Body.String(), "github-credential")
		var envelope struct {
			Code string         `json:"code"`
			Data map[string]any `json:"data"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &envelope))
		require.Equal(t, code, envelope.Code)
		if code == "0000" {
			require.Len(t, envelope.Data, 2)
		}
		testutil.ValidateResponse(t, spec, "/admin-api", req, rec)
		return envelope.Data
	}
	fetcher := changelog.NewFetcher("integration-test")
	fetcher.HTTP.TokenProvider = func(ctx context.Context) (string, error) { return st.GitHubToken(ctx, cfg) }
	requests, expected := 0, ""
	fetcher.HTTP.Client.Transport = githubRoundTrip(func(req *http.Request) (*http.Response, error) {
		requests++
		header := ""
		if expected != "" {
			header = "Bearer " + expected
		}
		require.Equal(t, header, req.Header.Get("Authorization"))
		require.Equal(t, "api.github.com", req.URL.Host)
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("[]")), Request: req}, nil
	})
	fetch := func() {
		t.Helper()
		_, err := fetcher.Fetch(ctx, changelog.Candidate{Kind: "cask"}, changelog.FetchSource{Type: "homebrew_commits", Config: map[string]any{"repo": "Homebrew/homebrew-cask", "path": "Casks/a/app.rb"}})
		require.NoError(t, err)
	}
	initial := call("GET", nil, "0000")
	require.Equal(t, "none", initial["tokenSource"])
	require.Equal(t, false, initial["tokenConfigured"])
	fetch()
	var encrypted string
	for _, credential := range []string{"first-admin-github-credential", "replacement-admin-github-credential"} {
		saved := call("PUT", map[string]any{"token": credential}, "0000")
		require.Equal(t, "admin", saved["tokenSource"])
		require.Equal(t, true, saved["tokenConfigured"])
		settings, err := st.GitHubSettings(ctx)
		require.NoError(t, err)
		require.NotEmpty(t, settings.TokenCiphertext)
		require.NotEqual(t, encrypted, settings.TokenCiphertext)
		require.NotContains(t, settings.TokenCiphertext, credential)
		encrypted = settings.TokenCiphertext
		plain, err := cfg.DecryptGitHubToken(encrypted)
		require.NoError(t, err)
		require.Equal(t, credential, plain)
		expected = credential
		fetch()
		call("GET", nil, "0000")
		for _, body := range []map[string]any{{}, {"token": ""}, {"clearToken": false}} {
			call("PUT", body, "0000")
			unchanged, err := st.GitHubSettings(ctx)
			require.NoError(t, err)
			require.Equal(t, encrypted, unchanged.TokenCiphertext)
		}
	}
	for _, body := range []map[string]any{{"token": "first-admin-github-credential", "clearToken": true}, {"token": "bad token"}, {"token": "bad\nheader"}, {"token": strings.Repeat("a", 4097)}} {
		call("PUT", body, "1001")
		unchanged, err := st.GitHubSettings(ctx)
		require.NoError(t, err)
		require.Equal(t, encrypted, unchanged.TokenCiphertext)
	}
	// Corrupt admin ciphertext must abort the request, never silently fall back to a startup token.
	require.NoError(t, st.DB.Exec("UPDATE github_settings SET token_ciphertext='invalid'").Error)
	before := requests
	_, err = fetcher.Fetch(ctx, changelog.Candidate{}, changelog.FetchSource{Type: "homebrew_commits", Config: map[string]any{"repo": "Homebrew/homebrew-cask", "path": "Casks/a/app.rb"}})
	require.EqualError(t, err, "GitHub credential unavailable")
	require.Equal(t, before, requests)
	cleared := call("PUT", map[string]any{"clearToken": true}, "0000")
	require.Equal(t, "none", cleared["tokenSource"])
	require.Equal(t, false, cleared["tokenConfigured"])
	expected = ""
	fetch()
	none := call("GET", nil, "0000")
	require.Equal(t, "none", none["tokenSource"])
	require.Equal(t, false, none["tokenConfigured"])
	fetch()
	var audit string
	require.NoError(t, st.DB.Raw("SELECT string_agg(coalesce(before::text,'')||coalesce(after::text,''),'') FROM audit_logs WHERE entity_type='github_settings'").Scan(&audit).Error)
	require.NotEmpty(t, audit)
	require.NotContains(t, audit, "github-credential")
	require.NotContains(t, audit, encrypted)
	require.NotContains(t, logs.String(), "github-credential")
	require.NotContains(t, logs.String(), encrypted)
	var roles []string
	require.NoError(t, st.DB.Raw("SELECT r.role_code FROM admin_role_permissions p JOIN admin_roles r ON r.id=p.role_id WHERE permission_code='system:github:edit'").Scan(&roles).Error)
	require.Equal(t, []string{"R_ADMIN"}, roles)
}
