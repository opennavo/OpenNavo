// Initialize About translations in development using the production worker's translation and budget controls.
package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/opennavo/opennavo/server/internal/about"
	"github.com/opennavo/opennavo/server/internal/config"
	"github.com/opennavo/opennavo/server/internal/content"
	"github.com/opennavo/opennavo/server/internal/llm/control"
	gateway "github.com/opennavo/opennavo/server/internal/llm/openai"
	"github.com/opennavo/opennavo/server/internal/service/contenttranslate"
	"github.com/opennavo/opennavo/server/internal/store"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "about translation failed; inspect translation settings and worker logs")
		os.Exit(1)
	}
}
func run() error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if cfg.AppEnv != "dev" {
		return fmt.Errorf("development only")
	}
	// Pin development resources so environment files cannot redirect this initializer to another database.
	cfg.DatabaseURL = "postgres://opennavo:opennavo-dev-only@localhost:55432/opennavo?sslmode=disable"
	cfg.RedisURL = "redis://localhost:56379/0"
	st, err := store.Open(ctx, cfg)
	if err != nil {
		return err
	}
	defer func() { _ = st.Close() }()
	var raw string
	if err := st.DB.WithContext(ctx).Raw("SELECT value::text FROM app_config WHERE key=?", about.Key).Scan(&raw).Error; err != nil {
		return err
	}
	c, err := about.Parse([]byte(raw))
	if err != nil {
		return err
	}
	language := &control.Client{Content: gateway.New(cfg), Store: st, Redis: st.Redis, Config: cfg, TranslationConfig: st.TranslationConfig}
	service := &contenttranslate.Service{Store: st, LLM: language}
	stats, err := service.Run(ctx, content.Ref{Entity: "about"}, c.SourceHash())
	if err == nil {
		fmt.Printf("about translation completed: calls=%v\n", stats["calls"])
	}
	return err
}
