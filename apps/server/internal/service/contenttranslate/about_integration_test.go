//go:build integration

package contenttranslate

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/opennavo/opennavo/server/gen/publicapi"
	"github.com/opennavo/opennavo/server/internal/about"
	"github.com/opennavo/opennavo/server/internal/content"
	"github.com/opennavo/opennavo/server/internal/llm"
	"github.com/opennavo/opennavo/server/internal/testutil"
	"github.com/stretchr/testify/require"
)

type aboutFake struct {
	t            *testing.T
	beforeReturn func()
	calls        int
	failures     int
}

func (f *aboutFake) TranslateContent(_ context.Context, in llm.ContentInput) (llm.ContentOutput, llm.Usage, error) {
	f.calls++
	usage := llm.Usage{Attempts: []llm.Attempt{{PromptTokens: 10, CompletionTokens: 5}}}
	if f.calls <= f.failures {
		return nil, usage, &llm.Failure{Reason: "temporary_gateway_error", Retryable: true}
	}
	require.Equal(f.t, "zh-CN", in.SourceLocale)
	require.Len(f.t, in.Fields, 2)
	require.NotContains(f.t, in.Fields, "openSource.title")
	out, err := validFake(in)
	if f.beforeReturn != nil {
		f.beforeReturn()
	}
	return out, usage, err
}

func TestAboutTranslationExcludesInventoryAndRejectsStaleWrite(t *testing.T) {
	testAboutQueuedTranslation(t, func(c about.Config) string { return c.SourceHash() })
}

func TestAboutTranslationAcceptsLegacyQueuedHashAndRejectsStaleWrite(t *testing.T) {
	testAboutQueuedTranslation(t, func(c about.Config) string {
		// Reproduce the pre-English-default job payload independently of SourceHash.
		raw, err := json.Marshal(c.Locales["zh-CN"])
		require.NoError(t, err)
		return fmt.Sprintf("%x", sha256.Sum256(raw))
	})
}

func testAboutQueuedTranslation(t *testing.T, queuedHash func(about.Config) string) {
	t.Helper()
	st := testutil.NewStore(t)
	ctx := context.Background()
	source := publicapi.AboutSection{Key: "about", Title: "应用介绍", Paragraphs: []string{"这款应用可以管理文件"}}
	oss := publicapi.AboutSection{Key: "openSource", Title: "Open source", Paragraphs: []string{"MIT"}}
	c := about.Config{SourceLocale: "zh-CN", Locales: map[string][]publicapi.AboutSection{"zh-CN": {source, oss}, "en-US": {source, oss}}, Modules: []publicapi.OpenSourceModule{{Ecosystem: "npm", Name: "vue", Version: "3.5.0", License: "MIT", Url: "https://github.com/vuejs/core"}}}
	write := func(value about.Config) {
		raw, err := json.Marshal(value)
		require.NoError(t, err)
		require.NoError(t, st.DB.Exec("INSERT INTO app_config(key,value) VALUES(?,?::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", about.Key, string(raw)).Error)
	}
	read := func() about.Config {
		var raw string
		require.NoError(t, st.DB.Raw("SELECT value::text FROM app_config WHERE key=?", about.Key).Scan(&raw).Error)
		value, err := about.Parse([]byte(raw))
		require.NoError(t, err)
		return value
	}
	write(c)
	fake := &aboutFake{t: t, failures: 1}
	service := Service{Store: st, LLM: fake}
	stats, err := service.Run(ctx, content.Ref{Entity: "about"}, queuedHash(c))
	require.NoError(t, err)
	require.Equal(t, 2, fake.calls)
	require.Equal(t, 2, stats["calls"])
	require.Equal(t, int64(30), stats["tokens"])
	got := read()
	require.Len(t, got.Locales, 6)
	require.Equal(t, c.Modules, got.Modules)
	require.Equal(t, oss, got.Locales["ja-JP"][1])
	require.Equal(t, translatedText["ja-JP"], got.Locales["ja-JP"][0].Title)
	require.Equal(t, source, got.Locales["zh-CN"][0])
	fake.beforeReturn = func() { c.Locales["zh-CN"][0].Title = "新介绍"; write(c) }
	oldHash := queuedHash(c)
	stats, err = service.Run(ctx, content.Ref{Entity: "about"}, oldHash)
	require.NoError(t, err)
	require.Equal(t, "stale", stats["skipped"])
	require.Equal(t, "新介绍", read().Locales["zh-CN"][0].Title)
	_, err = service.Run(ctx, content.Ref{Entity: "about"}, oldHash)
	require.NoError(t, err)
	require.Equal(t, 3, fake.calls)
}
