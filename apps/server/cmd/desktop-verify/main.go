package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/opennavo/opennavo/server/internal/config"
	"github.com/opennavo/opennavo/server/internal/service/assets"
	"github.com/opennavo/opennavo/server/internal/service/desktop"
	"github.com/opennavo/opennavo/server/internal/storage"
	"github.com/opennavo/opennavo/server/internal/store"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	err := run(ctx)
	stop()
	if err != nil {
		slog.Error("local desktop verification failed", "error", err)
		os.Exit(1)
	}
}
func run(ctx context.Context) (result error) {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if cfg.AppEnv != "dev" || (cfg.S3Endpoint != "127.0.0.1:9000" && cfg.S3Endpoint != "localhost:9000") {
		return errors.New("verification requires local development MinIO")
	}
	st, err := store.Open(ctx, cfg)
	if err != nil {
		return err
	}
	defer func() { _ = st.Close() }()
	client, err := storage.New(cfg)
	if err != nil {
		return err
	}
	objects := desktop.S3Objects{S3Objects: assets.S3Objects{Client: client}}
	svc := &desktop.Service{Store: st, Objects: objects}
	key := "desktop/beta/latest.json"
	old, err := objects.Read(ctx, key)
	if err != nil {
		return err
	}
	ids := []int64{}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		if len(ids) > 0 {
			result = errors.Join(result, st.DB.WithContext(cleanup).Exec("DELETE FROM desktop_releases WHERE id IN ?", ids).Error)
		}
		if old == nil {
			result = errors.Join(result, objects.Delete(cleanup, key))
		} else {
			result = errors.Join(result, objects.Put(cleanup, key, old, "application/json"))
		}
	}()
	suffix := strings.ToLower(rand.Text())
	for _, base := range []string{"0.0.1", "0.0.2"} {
		artifacts := []map[string]any{}
		for index, target := range []string{"darwin-aarch64", "darwin-x86_64", "dmg-universal"} {
			var signature any = "public-local-verification-signature"
			if target == "dmg-universal" {
				signature = nil
			}
			artifacts = append(artifacts, map[string]any{"target": target, "url": objects.URL("desktop/verification/" + target), "signature": signature, "bytes": int64(1024 + index), "sha256": strings.Repeat("a", 64)})
		}
		r, err := svc.Mutate(ctx, "CreateDesktopRelease", 0, map[string]any{"version": base + "-verify." + suffix, "channel": "beta", "notesZh": "本地发布验收夹具", "notesEn": "Local verification fixture", "artifacts": artifacts}, store.AuditActor{})
		if err != nil {
			return err
		}
		m, ok := r.(map[string]any)
		if !ok {
			return errors.New("invalid create response")
		}
		id, ok := m["id"].(int64)
		if !ok {
			return errors.New("invalid release id")
		}
		ids = append(ids, id)
		if _, err := svc.Mutate(ctx, "PublishDesktopRelease", id, nil, store.AuditActor{}); err != nil {
			return err
		}
	}
	if _, err := svc.Mutate(ctx, "RollbackDesktopRelease", ids[1], nil, store.AuditActor{}); err != nil {
		return err
	}
	latest, err := svc.Latest(ctx, "beta", "zh-CN")
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, objects.URL(key), nil)
	if err != nil {
		return err
	}
	response, err := (&http.Client{Timeout: 10 * time.Second}).Do(request)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != 200 {
		return errors.New("manifest is not anonymously readable")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return err
	}
	var manifest desktop.Manifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return err
	}
	if manifest.Version != latest.Version || !strings.HasPrefix(manifest.Version, "0.0.1-") || len(manifest.Platforms) != 2 {
		return errors.New("rollback manifest mismatch")
	}
	if err := os.MkdirAll("tmp/review", 0o750); err != nil {
		return err
	}
	if err := os.WriteFile("tmp/review/desktop_latest_verified.json", raw, 0o600); err != nil {
		return err
	}
	fmt.Printf("publish and rollback verified: HTTP 200, version=%s, platforms=%d; fixtures removed after verification\n", manifest.Version, len(manifest.Platforms))
	return nil
}
