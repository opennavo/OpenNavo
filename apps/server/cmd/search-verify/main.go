package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"

	"github.com/opennavo/opennavo/server/internal/cache"
	"github.com/opennavo/opennavo/server/internal/config"
	"github.com/opennavo/opennavo/server/internal/domain"
	"github.com/opennavo/opennavo/server/internal/service/search"
	"github.com/opennavo/opennavo/server/internal/store"
)

func main() {
	if err := run(context.Background()); err != nil {
		slog.Error("search verification failed", "error", err)
		os.Exit(1)
	}
}
func run(ctx context.Context) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if cfg.AppEnv != "dev" {
		return errors.New("search verification is limited to dev")
	}
	st, err := store.Open(ctx, cfg)
	if err != nil {
		return err
	}
	defer func() { _ = st.Close() }()
	count, err := st.ReindexSearch(ctx)
	if err != nil {
		return err
	}
	service := search.New(ctx, st, cache.Redis{Client: st.Redis}, slog.Default())
	defer service.Close()
	output := map[string]any{"indexed": count, "queries": map[string][]string{}}
	queries := output["queries"].(map[string][]string)
	for _, query := range []string{"vscode", "微信", "weixin", "docker", "rg", "python", "jetbrains mono"} {
		result, err := service.Search(ctx, domain.SearchInput{Query: query, Locale: "zh-CN", Platform: "web", Current: 1, Size: 3})
		if err != nil {
			return err
		}
		for _, match := range result.Records {
			var token string
			if err := st.DB.WithContext(ctx).Raw("SELECT token FROM packages WHERE id=?", match.ID).Scan(&token).Error; err != nil {
				return err
			}
			queries[query] = append(queries[query], token)
		}
	}
	return json.NewEncoder(os.Stdout).Encode(output)
}
