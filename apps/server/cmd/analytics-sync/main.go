package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"
	_ "time/tzdata"

	"github.com/hibiken/asynq"
	"github.com/opennavo/opennavo/server/internal/config"
	"github.com/opennavo/opennavo/server/internal/homebrew"
	"github.com/opennavo/opennavo/server/internal/jobs"
	"github.com/opennavo/opennavo/server/internal/service/catalog"
	"github.com/opennavo/opennavo/server/internal/store"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	err := run(ctx)
	stop()
	if err != nil {
		slog.Error("analytics sync failed", "error", err)
		os.Exit(1)
	}
}
func run(ctx context.Context) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	st, err := store.Open(ctx, cfg)
	if err != nil {
		return err
	}
	defer func() { _ = st.Close() }()
	location, err := time.LoadLocation(cfg.TZSchedule)
	if err != nil {
		return err
	}
	service := &catalog.AnalyticsService{Store: st, Source: homebrew.NewClient(cfg.HomebrewAPIBase, cfg.FetchUserAgent), Queue: &jobs.Enqueuer{Client: asynq.NewClientFromRedisClient(st.Redis), Redis: st.Redis}, Location: location}
	stats, err := catalog.RunAnalyticsOnce(ctx, service)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(stats)
}
