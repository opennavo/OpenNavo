//go:build live

package openai_test

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/opennavo/opennavo/server/internal/config"
	"github.com/opennavo/opennavo/server/internal/llm"
	"github.com/opennavo/opennavo/server/internal/llm/control"
	gateway "github.com/opennavo/opennavo/server/internal/llm/openai"
	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/stretchr/testify/require"
)

func TestLiveGatewaySmoke(t *testing.T) {
	if os.Getenv("OPENNAVO_LIVE_LLM") != "1" {
		t.Skip("use the llm-smoke backend command")
	}
	t.Chdir("../../..")
	cfg, err := config.Load()
	require.NoError(t, err)
	require.Equal(t, "dev", cfg.AppEnv)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	st, err := store.Open(ctx, cfg)
	require.NoError(t, err)
	defer func() { require.NoError(t, st.Close()) }()
	client := &control.Client{Content: gateway.New(cfg), Store: st, Redis: st.Redis, Config: cfg, TranslationConfig: st.TranslationConfig}
	out, usage, err := client.TranslateContent(ctx, llm.ContentInput{SourceLocale: "zh-CN", Targets: []string{"en-US"}, Fields: map[string]string{"summary": "用于管理文件的应用"}})
	require.NoError(t, err)
	require.NotEmpty(t, out["en-US"]["summary"])
	require.Positive(t, usage.Tokens())
}
