//go:build integration

package httpserver_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/opennavo/opennavo/server/gen/publicapi"
	"github.com/opennavo/opennavo/server/internal/cache"
	"github.com/opennavo/opennavo/server/internal/config"
	"github.com/opennavo/opennavo/server/internal/content"
	"github.com/opennavo/opennavo/server/internal/homebrew"
	httpserver "github.com/opennavo/opennavo/server/internal/http"
	"github.com/opennavo/opennavo/server/internal/http/public"
	"github.com/opennavo/opennavo/server/internal/llm"
	"github.com/opennavo/opennavo/server/internal/service/catalog"
	"github.com/opennavo/opennavo/server/internal/service/contenttranslate"
	"github.com/opennavo/opennavo/server/internal/service/management"
	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/opennavo/opennavo/server/internal/testutil"
	"github.com/stretchr/testify/require"
)

type hermesPublicTranslator struct{}

var hermesTranslated = map[string]string{
	"en-US": "The application manages your files", "ja-JP": "ファイルを管理するアプリです",
	"es-ES": "La aplicación permite gestionar tus archivos", "pt-BR": "O aplicativo permite gerenciar seus arquivos",
	"ru-RU": "Приложение для управления файлами",
}

func (hermesPublicTranslator) TranslateContent(_ context.Context, in llm.ContentInput) (llm.ContentOutput, llm.Usage, error) {
	out := llm.ContentOutput{}
	for _, locale := range in.Targets {
		out[locale] = map[string]string{}
		for field, source := range in.Fields {
			value := hermesTranslated[locale]
			for _, literal := range llm.LiteralSpans(source) {
				value += " " + literal
			}
			for _, term := range in.Protected {
				if strings.Contains(source, term) {
					value += " " + term
				}
			}
			out[locale][field] = value
		}
	}
	return out, llm.Usage{}, nil
}

// E2E does not start a worker; testcontainers and a fake LLM verify the real translation service through public HTTP here.
func TestHermesChineseContentFiveLocalesThroughPublicHTTP(t *testing.T) {
	ctx := context.Background()
	st := testutil.NewStore(t)
	p, err := homebrew.Normalize("cask", json.RawMessage(`{"token":"g-hermes","version":"1.0.0","name":["G Hermes"]}`))
	require.NoError(t, err)
	require.NoError(t, st.ApplyCatalogBatch(ctx, []store.CatalogMutation{{Package: p}}))
	var pid int64
	require.NoError(t, st.DB.Raw("SELECT id FROM packages WHERE token='g-hermes'").Scan(&pid).Error)
	manager := &management.Service{Store: st}
	_, err = manager.Execute(ctx, "UpdatePackageText", management.Input{ID: pid, Body: map[string]any{
		"sourceLocale": "zh-CN", "summary": "这款应用可以管理文件", "description": "支持 `code` 和 https://example.com 功能。",
	}})
	require.NoError(t, err)
	_, err = manager.Execute(ctx, "FixTranslation", management.Input{Body: map[string]any{
		"ref": map[string]any{"entity": "package", "id": pid}, "locale": "en-US",
		"fields": map[string]any{"summary": "G manual English summary", "description": "G manual English `code` https://example.com"},
	}})
	require.NoError(t, err)
	_, err = manager.Execute(ctx, "UpsertReleaseNotes", management.Input{ID: pid, Version: "1.0.0", Body: map[string]any{
		"sourceLocale": "zh-CN", "summary": "这款应用可以管理文件", "bodyMarkdown": "支持 `code` 和 https://example.com 功能。",
		"sections": []any{map[string]any{"area": "改进", "items": []any{"支持 `code` 和 https://example.com 功能。"}}},
	}})
	require.NoError(t, err)
	var rid int64
	require.NoError(t, st.DB.Raw("SELECT id FROM releases WHERE package_id=? AND source='editorial'", pid).Scan(&rid).Error)
	translator := &contenttranslate.Service{Store: st, LLM: hermesPublicTranslator{}, Model: "fake-g", NoRetry: true}
	for _, ref := range []content.Ref{{Entity: "package", ID: pid}, {Entity: "release", ID: rid}} {
		source, readErr := st.ReadContentSource(ctx, ref)
		require.NoError(t, readErr)
		want := 5
		if ref.Entity == "package" {
			want = 4
		}
		require.Len(t, source.Targets, want)
		stats, runErr := translator.Run(ctx, ref, source.Hash)
		require.NoError(t, runErr)
		require.Equal(t, want, stats["translated"])
	}
	pub := &catalog.PublicService{Store: st, Cache: cache.Redis{Client: st.Redis}}
	app, err := httpserver.New(config.Config{}, slog.New(slog.NewTextHandler(io.Discard, nil)), st, httpserver.Dependencies{Public: &public.Handler{Catalog: pub}})
	require.NoError(t, err)
	spec, err := publicapi.GetSpec()
	require.NoError(t, err)
	for locale, text := range hermesTranslated {
		t.Run(locale, func(t *testing.T) {
			for _, suffix := range []string{"", "/releases"} {
				req := httptest.NewRequest("GET", "/api/v1/packages/cask/g-hermes"+suffix+"?locale="+locale, nil)
				reply := httptest.NewRecorder()
				app.Engine.ServeHTTP(reply, req)
				require.Equal(t, 200, reply.Code)
				testutil.ValidateResponse(t, spec, "/api/v1", req, reply)
				expected := text
				if suffix == "" && locale == "en-US" {
					expected = "G manual English summary"
				}
				require.Contains(t, reply.Body.String(), expected)
				var envelope struct {
					Data map[string]any
				}
				require.NoError(t, json.Unmarshal(reply.Body.Bytes(), &envelope))
				translated := envelope.Data
				if suffix != "" {
					translated = envelope.Data["records"].([]any)[0].(map[string]any)
				}
				require.Equal(t, expected, translated["summary"])
				require.Equal(t, "zh-CN", translated["sourceLocale"])
				require.Equal(t, !(suffix == "" && locale == "en-US"), translated["machineTranslated"])
				require.Contains(t, reply.Body.String(), "https://example.com")
				require.Contains(t, reply.Body.String(), "code")
			}
		})
	}
	source, err := st.ReadContentSource(ctx, content.Ref{Entity: "package", ID: pid})
	require.NoError(t, err)
	require.Equal(t, "这款应用可以管理文件", source.Fields["summary"])
}
