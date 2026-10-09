//go:build integration

package httpserver_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/opennavo/opennavo/server/gen/publicapi"
	"github.com/opennavo/opennavo/server/internal/cache"
	"github.com/opennavo/opennavo/server/internal/config"
	"github.com/opennavo/opennavo/server/internal/homebrew"
	httpserver "github.com/opennavo/opennavo/server/internal/http"
	"github.com/opennavo/opennavo/server/internal/http/public"
	"github.com/opennavo/opennavo/server/internal/service/catalog"
	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/opennavo/opennavo/server/internal/testutil"
	"github.com/stretchr/testify/require"
)

func TestCaskPlatformDetailsAndDependenciesHTTP(t *testing.T) {
	ctx := context.Background()
	st := testutil.NewStore(t)
	mutations := []store.CatalogMutation{}
	for _, token := range []string{"raycast", "artisan", "visual-studio-code", "steam", "apple-hewlett-packard-printer-drivers"} {
		raw, err := os.ReadFile(filepath.Join("../../testdata/homebrew", token+".json")) // #nosec G304 -- Fixed test fixtures only.
		require.NoError(t, err)
		item, err := homebrew.Normalize("cask", raw)
		require.NoError(t, err)
		mutations = append(mutations, store.CatalogMutation{Package: item})
	}
	// Conditional parent and child variants must use the same label; unavailable child variants cannot borrow another platform's version.
	for _, raw := range []string{
		`{"token":"dependency-root","name":["Dependency Root"],"version":"2","supported_platforms":["arm64_sonoma","sonoma"],"depends_on":{"cask":["dependency-child","dependency-arm-only"],"formula":["arm-runtime"],"macos":{">=":["14"]}},"conflicts_with":{"cask":["arm-conflict"]},"variations":{"sonoma":{"depends_on":{"cask":["dependency-child","dependency-arm-only"],"formula":["intel-runtime"],"macos":{">=":["13"]}},"conflicts_with":{}}}}`,
		`{"token":"dependency-child","name":["Dependency Child"],"version":"2","supported_platforms":["arm64_sonoma","sonoma"],"depends_on":{"formula":["arm-child-runtime"]},"variations":{"sonoma":{"version":"1","depends_on":{"formula":["intel-child-runtime"]}}}}`,
		`{"token":"dependency-arm-only","name":["Dependency Arm Only"],"version":"9","supported_platforms":["arm64_sonoma"],"depends_on":{"formula":["arm-only-runtime"]}}`,
	} {
		item, err := homebrew.Normalize("cask", json.RawMessage(raw))
		require.NoError(t, err)
		mutations = append(mutations, store.CatalogMutation{Package: item})
	}
	require.NoError(t, st.ApplyCatalogBatch(ctx, mutations))
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	service := &catalog.PublicService{Store: st, Cache: cache.Redis{Client: st.Redis}, WebBaseURL: "http://127.0.0.1:3001"}
	server, err := httpserver.New(config.Config{WebBaseURL: "http://127.0.0.1:3001", PublicCORSOrigins: []string{"http://127.0.0.1:1421"}}, logger, st, httpserver.Dependencies{Public: &public.Handler{Catalog: service}})
	require.NoError(t, err)
	spec, err := publicapi.GetSpec()
	require.NoError(t, err)
	for _, mutation := range mutations {
		for _, suffix := range []string{"", "/dependencies"} {
			request := httptest.NewRequest("GET", "/api/v1/packages/cask/"+mutation.Package.Token+suffix, nil)
			reply := httptest.NewRecorder()
			server.Engine.ServeHTTP(reply, request)
			require.Equal(t, 200, reply.Code, reply.Body.String())
			testutil.ValidateResponse(t, spec, "/api/v1", request, reply)
			var body struct {
				Data struct {
					Platforms []publicapi.CaskPlatform `json:"platforms"`
					Supports  struct {
						Status string `json:"status"`
					} `json:"supports"`
				} `json:"data"`
			}
			require.NoError(t, json.Unmarshal(reply.Body.Bytes(), &body))
			require.NotEmpty(t, body.Data.Platforms)
			if suffix == "" {
				require.Equal(t, "known", body.Data.Supports.Status)
			}
			for _, platform := range body.Data.Platforms {
				require.NotNil(t, platform.Artifacts.Entries)
				require.NotNil(t, platform.DependsOn.Requirements)
				if platform.Arch == publicapi.CaskPlatformArchX8664 {
					require.False(t, platform.RequiresRosetta)
				}
			}
		}
	}
	for _, example := range []struct {
		tag, formula, childFormula, childVersion string
		arm                                      bool
	}{
		{"arm64_sonoma", "arm-runtime", "arm-child-runtime", "2", true},
		{"sonoma", "intel-runtime", "intel-child-runtime", "1", false},
	} {
		request := httptest.NewRequest("GET", "/api/v1/packages/cask/dependency-root/dependencies?platform="+example.tag+"&depth=3", nil)
		reply := httptest.NewRecorder()
		server.Engine.ServeHTTP(reply, request)
		require.Equal(t, 200, reply.Code, reply.Body.String())
		testutil.ValidateResponse(t, spec, "/api/v1", request, reply)
		var body struct {
			Data publicapi.Dependencies `json:"data"`
		}
		require.NoError(t, json.Unmarshal(reply.Body.Bytes(), &body))
		require.Equal(t, []string{example.formula}, body.Data.DependsOn.Formulae)
		require.Len(t, body.Data.DependsOn.Arch, 1)
		require.Len(t, body.Data.Dependencies, 3)
		require.Equal(t, example.formula, body.Data.Dependencies[0].Token)
		child := body.Data.Dependencies[1]
		require.Equal(t, "dependency-child", child.Token)
		require.NotNil(t, child.Version)
		require.Equal(t, example.childVersion, *child.Version)
		require.Len(t, child.Children, 1)
		require.Equal(t, example.childFormula, child.Children[0].Token)
		armOnly := body.Data.Dependencies[2]
		if example.arm {
			require.Equal(t, []string{"arm-conflict"}, body.Data.ConflictsWith.Casks)
			require.NotNil(t, armOnly.Version)
			require.Equal(t, "9", *armOnly.Version)
			require.Len(t, armOnly.Children, 1)
		} else {
			require.Empty(t, body.Data.ConflictsWith.Casks)
			require.Nil(t, armOnly.Version)
			require.Empty(t, armOnly.Children)
		}
	}
	unsupported := httptest.NewRequest("GET", "/api/v1/packages/cask/dependency-root/dependencies?platform=ventura", nil)
	reply := httptest.NewRecorder()
	server.Engine.ServeHTTP(reply, unsupported)
	require.Equal(t, 400, reply.Code, reply.Body.String())
	testutil.ValidateResponse(t, spec, "/api/v1", unsupported, reply)
	// When explicitly enabled, reuse this isolated database for browser-use verification; the sentinel stops only services created by this test.
	if address := os.Getenv("CASK_BROWSER_ADDR"); address != "" {
		require.True(t, strings.HasPrefix(address, "127.0.0.1:"))
		listener, err := net.Listen("tcp", address)
		require.NoError(t, err)
		preview := httptest.NewUnstartedServer(server.Engine)
		_ = preview.Listener.Close()
		preview.Listener = listener
		preview.Start()
		t.Cleanup(preview.Close)
		t.Logf("browser fixture ready: %s", preview.URL)
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		timeout := time.NewTimer(15 * time.Minute)
		defer timeout.Stop()
		for {
			select {
			case <-ticker.C:
				if _, err := os.Stat("../../tmp/homebrew-compatibility-probe/browser-stop"); err == nil {
					return
				}
			case <-timeout.C:
				t.Fatal("browser verification did not finish before timeout")
			}
		}
	}
}
