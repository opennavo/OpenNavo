package main

import (
	"context"
	"log/slog"
	"os"
	"time"
	_ "time/tzdata"

	"github.com/opennavo/opennavo/server/internal/config"
	"github.com/opennavo/opennavo/server/internal/storage"
)

func main() {
	if err := run(); err != nil {
		slog.Error("object-storage bootstrap failed")
		os.Exit(1)
	}
	slog.Info("object-storage buckets ready")
}
func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	client, err := storage.New(cfg)
	if err != nil {
		return err
	}
	slog.Info("object-storage configuration", "public_bucket", cfg.S3Bucket, "private_bucket", cfg.S3PrivateBucket, "public_access", cfg.S3PublicAccess)
	return client.EnsureBuckets(ctx, cfg.S3Region)
}
