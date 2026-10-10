//go:build integration && releaseverify

package httpserver_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/opennavo/opennavo/server/gen/adminapi"
	"github.com/opennavo/opennavo/server/internal/config"
	httpserver "github.com/opennavo/opennavo/server/internal/http"
	"github.com/opennavo/opennavo/server/internal/http/admin"
	"github.com/opennavo/opennavo/server/internal/http/public"
	"github.com/opennavo/opennavo/server/internal/service/assets"
	"github.com/opennavo/opennavo/server/internal/service/auth"
	"github.com/opennavo/opennavo/server/internal/service/desktop"
	"github.com/opennavo/opennavo/server/internal/service/management"
	"github.com/opennavo/opennavo/server/internal/service/seed"
	"github.com/opennavo/opennavo/server/internal/storage"
	"github.com/opennavo/opennavo/server/internal/testutil"
	"github.com/opennavo/opennavo/server/seeds"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
)

type collectedDesktopArtifact struct {
	Target    string  `json:"target"`
	File      string  `json:"file"`
	URL       string  `json:"url"`
	Signature *string `json:"signature,omitempty"`
	Bytes     int64   `json:"bytes"`
	SHA256    string  `json:"sha256"`
}

type desktopPipelineReport struct {
	BaselineVersion   string                     `json:"baselineVersion"`
	CandidateVersion  string                     `json:"candidateVersion"`
	NativeTarget      string                     `json:"nativeTarget"`
	StandInTargets    []string                   `json:"standInTargets"`
	Artifacts         []collectedDesktopArtifact `json:"artifacts"`
	PublicationDates  map[string]time.Time       `json:"publicationDates"`
	AnonymousReads    int                        `json:"anonymousArtifactReads"`
	SignedTargets     int                        `json:"signedUpdaterTargetsVerified"`
	RegisteredDrafts  int                        `json:"registeredDrafts"`
	PublishedVersions []string                   `json:"publishedVersions"`
	RestoredVersion   string                     `json:"restoredVersion"`
	ExactRollback     bool                       `json:"exactManifestRestored"`
}

// A separate tag keeps normal integration tests independent of local native packaging. Signing uses development keys only from ignored directories.
// The two stub targets verify naming, upload and registration protocols only; they do not prove Intel/Universal executability.
func TestNativeDesktopReleasePipelineWithRealStorage(t *testing.T) {
	baselineBundle, candidateBundle := os.Getenv("RELEASE_VERIFY_BASELINE_BUNDLE"), os.Getenv("RELEASE_VERIFY_BUNDLE")
	require.NotEmpty(t, baselineBundle, "RELEASE_VERIFY_BASELINE_BUNDLE is required")
	require.NotEmpty(t, candidateBundle, "RELEASE_VERIFY_BUNDLE is required")
	baselineVersion, candidateVersion := "0.0.2", "0.0.3"
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	st := testutil.NewStore(t)
	container, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{ContainerRequest: testcontainers.ContainerRequest{
		Image: "opennavo-minio:dev", ExposedPorts: []string{"9000/tcp"},
		Env: map[string]string{"MINIO_ROOT_USER": "release-verification", "MINIO_ROOT_PASSWORD": "development-release-verification-only"},
		Cmd: []string{"server", "/data"}, WaitingFor: wait.ForHTTP("/minio/health/ready").WithPort("9000/tcp"),
	}, Started: true})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, container.Terminate(context.Background())) })
	host, err := container.Host(ctx)
	require.NoError(t, err)
	port, err := container.MappedPort(ctx, "9000/tcp")
	require.NoError(t, err)
	endpoint := host + ":" + port.Port()
	cfg := config.Config{
		S3Endpoint: endpoint, S3Region: "us-east-1", S3Bucket: "release-verification",
		S3AccessKey: "release-verification", S3SecretKey: "development-release-verification-only",
		CDNBaseURL: "http://" + endpoint + "/release-verification",
		JWTSecret:  strings.Repeat("v", 32), JWTAccessTTL: time.Hour, JWTRefreshTTL: time.Hour,
	}
	storageClient, err := storage.New(cfg)
	require.NoError(t, err)
	require.NoError(t, storageClient.EnsurePublicPrefixes(ctx, cfg.S3Region))
	objects := desktop.S3Objects{S3Objects: assets.S3Objects{Client: storageClient}}
	data, err := seeds.Load()
	require.NoError(t, err)
	hash, err := seed.HashPassword("development-release-password")
	require.NoError(t, err)
	require.NoError(t, st.Seed(ctx, data, "release-verifier", hash))
	authentication, err := auth.New(st, cfg)
	require.NoError(t, err)
	svc := &desktop.Service{Store: st, Objects: objects}
	manager := &management.Service{Store: st, Desktop: svc}
	ciToken := "isolated-development-release-ci"
	app, err := httpserver.New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), st, httpserver.Dependencies{
		Admin:  &admin.Handler{Auth: authentication, Management: manager, CIToken: ciToken},
		Public: &public.Handler{Desktop: svc},
	})
	require.NoError(t, err)
	api := httptest.NewServer(app.Engine)
	t.Cleanup(api.Close)
	client := &http.Client{Timeout: 15 * time.Second}
	call := func(method, path string, input any, token, code string, output any) {
		t.Helper()
		var body []byte
		if input != nil {
			body, err = json.Marshal(input)
			require.NoError(t, err)
		}
		req, reqErr := http.NewRequestWithContext(ctx, method, api.URL+path, bytes.NewReader(body))
		require.NoError(t, reqErr)
		if input != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		response, reqErr := client.Do(req)
		require.NoError(t, reqErr)
		defer func() { require.NoError(t, response.Body.Close()) }()
		require.Equal(t, http.StatusOK, response.StatusCode)
		var envelope struct {
			Code string          `json:"code"`
			Data json.RawMessage `json:"data"`
		}
		require.NoError(t, json.NewDecoder(response.Body).Decode(&envelope))
		require.Equal(t, code, envelope.Code, "%s %s", method, path)
		if output != nil {
			require.NoError(t, json.Unmarshal(envelope.Data, output))
		}
	}
	var pair adminapi.LoginToken
	call("POST", "/admin-api/auth/login", map[string]string{"userName": "release-verifier", "password": "development-release-password"}, "", "0000", &pair)
	root, err := filepath.Abs("../../../..")
	require.NoError(t, err)
	report := desktopPipelineReport{
		BaselineVersion: baselineVersion, CandidateVersion: candidateVersion,
		NativeTarget: "darwin-aarch64", StandInTargets: []string{"darwin-x86_64", "dmg-universal"},
		PublicationDates: map[string]time.Time{},
	}
	targets := []string{"darwin-aarch64", "darwin-x86_64", "dmg-universal"}
	ids := map[string]int64{}
	cliEnv := []string{"PATH=" + os.Getenv("PATH"), "ADMIN_API_BASE=" + api.URL + "/admin-api", "CI_RELEASE_TOKEN=" + ciToken}
	for _, release := range []struct{ version, bundle string }{{baselineVersion, baselineBundle}, {candidateVersion, candidateBundle}} {
		out := t.TempDir()
		files, openErr := os.OpenRoot(out)
		require.NoError(t, openErr)
		t.Cleanup(func() { require.NoError(t, files.Close()) })
		for _, target := range targets {
			runDesktopReleaseCLI(t, ctx, root, cliEnv, "release-artifacts.mjs", "--target", target, "--version", release.version,
				"--base-url", cfg.CDNBaseURL+"/desktop", "--bundle-dir", release.bundle, "--out", out)
			raw, readErr := files.ReadFile(target + ".json")
			require.NoError(t, readErr)
			var artifact collectedDesktopArtifact
			require.NoError(t, json.Unmarshal(raw, &artifact))
			require.Equal(t, target, artifact.Target)
			require.Equal(t, cfg.CDNBaseURL+"/desktop/"+release.version+"/"+artifact.File, artifact.URL)
			require.Equal(t, filepath.Base(artifact.File), artifact.File)
			content, readErr := files.ReadFile(artifact.File)
			require.NoError(t, readErr)
			require.Greater(t, len(content), 1<<20, "must use native artifacts, not route fixtures")
			digest := sha256.Sum256(content)
			require.Equal(t, hex.EncodeToString(digest[:]), artifact.SHA256)
			require.Equal(t, int64(len(content)), artifact.Bytes)
			mime := "application/gzip"
			if target == "dmg-universal" {
				mime = "application/x-apple-diskimage"
				require.Nil(t, artifact.Signature)
			} else {
				require.NotNil(t, artifact.Signature)
				require.NotEmpty(t, strings.TrimSpace(*artifact.Signature))
				signature, readErr := files.ReadFile(artifact.File + ".sig")
				require.NoError(t, readErr)
				require.Equal(t, *artifact.Signature, strings.TrimSpace(string(signature)))
				require.NoError(t, objects.Put(ctx, "desktop/"+release.version+"/"+artifact.File+".sig", signature, "text/plain"))
				remoteSignature, _ := anonymousReleaseObject(t, ctx, client, artifact.URL+".sig")
				require.True(t, bytes.Equal(signature, remoteSignature), "uploaded signature must match the collected signature")
				report.SignedTargets++
			}
			require.NoError(t, objects.Put(ctx, "desktop/"+release.version+"/"+artifact.File, content, mime))
			download, headers := anonymousReleaseObject(t, ctx, client, artifact.URL)
			require.True(t, bytes.Equal(content, download), "anonymous artifact must match the native bundle")
			require.Equal(t, mime, headers.Get("Content-Type"))
			report.AnonymousReads++
			// Reports contain only file metadata; manifests and public signatures are not written to reports.
			artifact.Signature = nil
			report.Artifacts = append(report.Artifacts, artifact)
		}
		runDesktopReleaseCLI(t, ctx, root, cliEnv, "register-release.mjs", "--dir", out, "--version", release.version, "--channel", "stable",
			"--notes-en", "Local release drill "+release.version+": browse, search and updates.")
		var id int64
		require.NoError(t, st.DB.WithContext(ctx).Table("desktop_releases").Where("version = ? AND channel = ? AND status = ?", release.version, "stable", "draft").Select("id").Scan(&id).Error)
		require.Positive(t, id)
		ids[release.version] = id
		report.RegisteredDrafts++
	}
	manifestURL := cfg.CDNBaseURL + "/desktop/stable/latest.json"
	manifests := map[string][]byte{}
	for _, version := range []string{baselineVersion, candidateVersion} {
		path := "/admin-api/desktop-releases/" + strconv.FormatInt(ids[version], 10) + "/publish"
		call("POST", path, nil, ciToken, "1004", nil)
		call("POST", path, nil, pair.Token, "0000", nil)
		row, rowErr := st.DesktopRelease(ctx, ids[version])
		require.NoError(t, rowErr)
		require.Equal(t, "published", row.Status)
		expected, rowErr := desktop.Generate(row)
		require.NoError(t, rowErr)
		expected.PubDate = expected.PubDate.UTC()
		body, headers := anonymousReleaseObject(t, ctx, client, manifestURL)
		require.Equal(t, "application/json", headers.Get("Content-Type"))
		require.Equal(t, "public, max-age=60", headers.Get("Cache-Control"))
		var actual desktop.Manifest
		require.NoError(t, json.Unmarshal(body, &actual))
		require.Equal(t, expected, actual)
		require.Equal(t, version, actual.Version)
		require.False(t, actual.PubDate.IsZero())
		require.WithinDuration(t, time.Now(), actual.PubDate, time.Minute)
		require.Contains(t, actual.Notes, version)
		require.Len(t, actual.Platforms, 2)
		for _, target := range targets[:2] {
			platform := actual.Platforms[target]
			require.NotEmpty(t, platform.Signature)
			require.Contains(t, platform.URL, "/desktop/"+version+"/")
			_, _ = anonymousReleaseObject(t, ctx, client, platform.URL)
		}
		manifests[version] = body
		report.PublicationDates[version] = actual.PubDate
		report.PublishedVersions = append(report.PublishedVersions, version)
	}
	call("POST", "/admin-api/desktop-releases/"+strconv.FormatInt(ids[candidateVersion], 10)+"/rollback", nil, pair.Token, "0000", nil)
	restored, _ := anonymousReleaseObject(t, ctx, client, manifestURL)
	require.True(t, bytes.Equal(manifests[baselineVersion], restored), "rollback must restore URLs, signatures, notes and original publication date")
	row, err := st.DesktopRelease(ctx, ids[candidateVersion])
	require.NoError(t, err)
	require.Equal(t, "rolled_back", row.Status)
	var latest struct{ Version string }
	call("GET", "/api/v1/desktop/releases/latest", nil, "", "0000", &latest)
	require.Equal(t, baselineVersion, latest.Version)
	report.ExactRollback, report.RestoredVersion = true, latest.Version
	if os.Getenv("RELEASE_VERIFY_REPORT") == "1" {
		destination := filepath.Join(root, "apps/server/tmp/review/desktop_release_verification.json")
		encoded, encodeErr := json.MarshalIndent(report, "", "  ")
		require.NoError(t, encodeErr)
		require.NoError(t, os.MkdirAll(filepath.Dir(destination), 0o700))
		require.NoError(t, os.WriteFile(destination, append(encoded, '\n'), 0o600))
	}
	t.Logf("two real-artifact drafts registered; %s -> %s -> %s; manifest restored byte-for-byte; 6 anonymous downloads verified; Intel and Universal are arm64 stand-ins", baselineVersion, candidateVersion, baselineVersion)
}

func runDesktopReleaseCLI(t *testing.T, ctx context.Context, root string, environment []string, script string, arguments ...string) {
	t.Helper()
	require.Contains(t, []string{"release-artifacts.mjs", "register-release.mjs"}, script)
	command := exec.CommandContext(ctx, "node", append([]string{filepath.Join(root, "apps/desktop/scripts", script)}, arguments...)...) //nolint:gosec // Only two controlled repository scripts run; arguments are local packaging and temporary paths, never tokens.
	command.Dir, command.Env = root, environment
	// Pass CI tokens only in the child environment; keep raw CLI output in memory and never print requests or secrets, even on failure.
	_, err := command.CombinedOutput()
	require.NoError(t, err, "%s failed; output suppressed", script)
}

func anonymousReleaseObject(t *testing.T, ctx context.Context, client *http.Client, url string) ([]byte, http.Header) {
	t.Helper()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	require.NoError(t, err)
	response, err := client.Do(req)
	require.NoError(t, err)
	defer func() { require.NoError(t, response.Body.Close()) }()
	require.Equal(t, http.StatusOK, response.StatusCode)
	data, err := io.ReadAll(io.LimitReader(response.Body, 128<<20))
	require.NoError(t, err)
	return data, response.Header
}
