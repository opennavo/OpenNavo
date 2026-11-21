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

type verificationObject struct {
	bucket string
	key    string
}

func main() {
	if err := run(); err != nil {
		slog.Error("local infrastructure verification failed", "error", err)
		os.Exit(1)
	}
	slog.Info("verified four public prefixes, private object isolation and asynqmon ready")
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
	var objects []verificationObject
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		for _, object := range objects {
			_ = client.S3.RemoveObject(cleanup, object.bucket, object.key, minio.RemoveObjectOptions{})
		}
	}()
	for _, prefix := range storage.PublicPrefixes {
		key := prefix + suffix
		if _, err := client.S3.PutObject(ctx, client.PublicBucket, key, strings.NewReader(body), int64(len(body)), minio.PutObjectOptions{ContentType: "text/plain"}); err != nil {
			return errors.New("cannot write isolated public verification object")
		}
		objects = append(objects, verificationObject{bucket: client.PublicBucket, key: key})
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
		if response.StatusCode != http.StatusOK || string(data) != body {
			return fmt.Errorf("anonymous read failed for prefix %s", prefix)
		}
	}

	privateKey := "private/" + suffix
	if _, err := client.S3.PutObject(ctx, client.PrivateBucket, privateKey, strings.NewReader(body), int64(len(body)), minio.PutObjectOptions{ContentType: "text/plain"}); err != nil {
		return errors.New("cannot write isolated private verification object")
	}
	objects = append(objects, verificationObject{bucket: client.PrivateBucket, key: privateKey})
	if _, err := client.S3.StatObject(ctx, client.PrivateBucket, privateKey, minio.StatObjectOptions{}); err != nil {
		return errors.New("cannot read isolated private verification object")
	}
	// StatObject only proves the authenticated write. The isolation check is an anonymous GET
	// through the public CDN: a 200 means the key is reachable publicly, whether the CDN points at
	// the private bucket or serves a fallback page. Same-bucket MinIO returns 403; a separate
	// private bucket is absent from the public bucket and returns 404.
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(cfg.CDNBaseURL, "/")+"/"+privateKey, nil)
	if err != nil {
		return err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return errors.New("anonymous private object request failed")
	}
	status := response.StatusCode
	_ = response.Body.Close()
	switch status {
	case http.StatusForbidden, http.StatusNotFound:
	case http.StatusOK:
		return errors.New("private object was publicly accessible")
	default:
		return fmt.Errorf("unexpected private object status %d", status)
	}

	request, err = http.NewRequestWithContext(ctx, http.MethodGet, "http://localhost:8081/api/queues", nil)
	if err != nil {
		return err
	}
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		return errors.New("asynqmon unavailable")
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return errors.New("asynqmon queue endpoint unavailable")
	}
	return nil
}
