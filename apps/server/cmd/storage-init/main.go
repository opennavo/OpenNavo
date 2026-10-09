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
		slog.Error("local object-storage bootstrap failed")
		os.Exit(1)
	}
	slog.Info("object-storage public prefixes ready")
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
	return client.EnsurePublicPrefixes(ctx, cfg.S3Region)
}
