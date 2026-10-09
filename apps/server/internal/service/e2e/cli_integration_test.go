//go:build integration && e2ecli

package e2e

import (
	"context"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/opennavo/opennavo/server/internal/config"
	"github.com/opennavo/opennavo/server/internal/storage"
	"github.com/opennavo/opennavo/server/internal/testutil"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
	pgdriver "gorm.io/driver/postgres"
)

// Local entry-point acceptance uses the MinIO image built by make infra; normal CI integration tests do not depend on local images.
func TestMakeSeedE2EWithIsolatedInfrastructure(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	st := testutil.NewStore(t)
	container, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{ContainerRequest: testcontainers.ContainerRequest{Image: "opennavo-minio:dev", ExposedPorts: []string{"9000/tcp"}, Env: map[string]string{"MINIO_ROOT_USER": "e2e-minio", "MINIO_ROOT_PASSWORD": "e2e-minio-dev-only"}, Cmd: []string{"server", "/data"}, WaitingFor: wait.ForHTTP("/minio/health/ready").WithPort("9000/tcp")}, Started: true})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, container.Terminate(context.Background())) })
	host, err := container.Host(ctx)
	require.NoError(t, err)
	port, err := container.MappedPort(ctx, "9000/tcp")
	require.NoError(t, err)
	endpoint := host + ":" + port.Port()
	cfg := config.Config{S3Endpoint: endpoint, S3Region: "us-east-1", S3Bucket: "opennavo", S3AccessKey: "e2e-minio", S3SecretKey: "e2e-minio-dev-only", CDNBaseURL: "http://" + endpoint + "/opennavo"}
	objects, err := storage.New(cfg)
	require.NoError(t, err)
	require.NoError(t, objects.EnsurePublicPrefixes(ctx, cfg.S3Region))
	root, err := filepath.Abs("../../../../..")
	require.NoError(t, err)
	defaults, err := os.ReadFile(filepath.Join(root, "apps", "server", ".env.example"))
	require.NoError(t, err)
	variables := map[string]string{}
	for _, entry := range os.Environ() {
		key, value, _ := strings.Cut(entry, "=")
		variables[key] = value
	}
	for _, entry := range strings.Split(string(defaults), "\n") {
		key, value, ok := strings.Cut(entry, "=")
		if ok && !strings.HasPrefix(key, "#") {
			variables[key] = value
		}
	}
	variables["DATABASE_URL"] = st.DB.Dialector.(*pgdriver.Dialector).Config.DSN
	variables["REDIS_URL"] = "redis://" + st.Redis.Options().Addr + "/0"
	variables["S3_ENDPOINT"] = endpoint
	variables["S3_ACCESS_KEY"], variables["S3_SECRET_KEY"] = cfg.S3AccessKey, cfg.S3SecretKey
	variables["CDN_BASE_URL"] = cfg.CDNBaseURL
	// Point unused external services to unreachable local ports so this entry point relies entirely on embedded data.
	variables["HOMEBREW_API_BASE"], variables["LLM_BASE_URL"] = "http://127.0.0.1:1", "http://127.0.0.1:1"
	commandEnv := []string{}
	for key, value := range variables {
		commandEnv = append(commandEnv, key+"="+value)
	}
	for range 2 {
		command := exec.CommandContext(ctx, "make", "seed-e2e")
		command.Dir, command.Env = root, commandEnv
		output, err := command.CombinedOutput()
		require.NoError(t, err, "%s", output)
		require.Contains(t, string(output), "seed-e2e completed")
	}
	record, err := st.LatestSnapshot(ctx)
	require.NoError(t, err)
	require.Equal(t, 40, record.ItemCount)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, record.URL, nil)
	require.NoError(t, err)
	response, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, response.StatusCode)
	require.NoError(t, response.Body.Close())
	var snapshots int64
	require.NoError(t, st.DB.Table("catalog_snapshots").Count(&snapshots).Error)
	require.Equal(t, int64(1), snapshots)
}
