package main

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/opennavo/opennavo/server/internal/config"
	"github.com/opennavo/opennavo/server/internal/storage"
)

func main() {
	if err := run(); err != nil {
		slog.Error("local infrastructure verification failed", "error", err)
		os.Exit(1)
	}
	slog.Info("verified four public prefixes, private access denied and asynqmon ready")
}
func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if cfg.AppEnv != "dev" {
		return errors.New("infrastructure verification is limited to dev")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	client, err := storage.New(cfg)
	if err != nil {
		return err
	}
	suffix := "__verify-" + rand.Text() + ".txt"
	body := "OpenNavo local storage verification"
	var keys []string
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		for _, key := range keys {
			_ = client.S3.RemoveObject(cleanup, client.Bucket, key, minio.RemoveObjectOptions{})
		}
	}()
	for _, prefix := range append(append([]string{}, storage.PublicPrefixes...), "private/") {
		key := prefix + suffix
		if _, err := client.S3.PutObject(ctx, client.Bucket, key, strings.NewReader(body), int64(len(body)), minio.PutObjectOptions{ContentType: "text/plain"}); err != nil {
			return errors.New("cannot write isolated verification object")
		}
		keys = append(keys, key)
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(cfg.CDNBaseURL, "/")+"/"+key, nil)
		if err != nil {
			return err
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			return errors.New("anonymous object request failed")
		}
		data, readErr := io.ReadAll(io.LimitReader(response.Body, 1024))
		_ = response.Body.Close()
		if readErr != nil {
			return readErr
		}
		if prefix == "private/" {
			if response.StatusCode != http.StatusForbidden {
				return errors.New("private object was publicly accessible")
			}
		} else if response.StatusCode != http.StatusOK || string(data) != body {
			return fmt.Errorf("anonymous read failed for prefix %s", prefix)
		}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://localhost:8081/api/queues", nil)
	if err != nil {
		return err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return errors.New("asynqmon unavailable")
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return errors.New("asynqmon queue endpoint unavailable")
	}
	return nil
}
