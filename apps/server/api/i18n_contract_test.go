package api_test

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/opennavo/opennavo/server/internal/i18n"
	"github.com/stretchr/testify/require"
)

func localeCodes(t *testing.T) []string {
	t.Helper()
	data, err := os.ReadFile("../../../packages/shared/src/locales.json")
	require.NoError(t, err)
	var manifest struct {
		DefaultLocale string `json:"defaultLocale"`
		Locales       []struct {
			Code string `json:"code"`
		} `json:"locales"`
	}
	require.NoError(t, json.Unmarshal(data, &manifest))
	require.Equal(t, "en-US", manifest.DefaultLocale)
	codes := make([]string, len(manifest.Locales))
	for index, locale := range manifest.Locales {
		codes[index] = locale.Code
	}
	return codes
}

func loadContract(t *testing.T, name string) *openapi3.T {
	t.Helper()
	loader := openapi3.NewLoader()
	loader.IsExternalRefsAllowed = false
	spec, err := loader.LoadFromFile(name + ".openapi.yaml")
	require.NoError(t, err)
	require.NoError(t, spec.Validate(context.Background()))
	return spec
}

func TestLocaleManifestGeneratedConstantsAndBothContractsAgree(t *testing.T) {
	codes := localeCodes(t)
	generated := make([]string, len(i18n.Locales))
	for index, locale := range i18n.Locales {
		generated[index] = string(locale)
	}
	require.Equal(t, codes, generated)
	for _, name := range []string{"public", "admin"} {
		spec := loadContract(t, name)
		enum := spec.Components.Schemas["Locale"].Value.Enum
		actual := make([]string, len(enum))
		for index, value := range enum {
			actual[index] = value.(string)
		}
		require.Equal(t, codes, actual, name)
	}
}

func TestI18nContractStaticExamplesConformIncludingEveryLocale(t *testing.T) {
	codes := localeCodes(t)
	for _, name := range []string{"public", "admin"} {
		spec := loadContract(t, name)
		for schemaName, ref := range spec.Components.Schemas {
			t.Run(name+"/schema/"+schemaName, func(t *testing.T) {
				require.NotNil(t, ref.Value.Example)
				require.NoError(t, ref.Value.VisitJSON(ref.Value.Example))
			})
		}
		for path, item := range spec.Paths.Map() {
			for method, op := range item.Operations() {
				t.Run(name+"/"+method+path, func(t *testing.T) {
					if op.RequestBody != nil {
						for _, media := range op.RequestBody.Value.Content {
							if media.Example != nil {
								require.NoError(t, media.Schema.Value.VisitJSON(media.Example))
							}
						}
					}
					response := op.Responses.Status(200)
					if response == nil {
						return
					}
					media := response.Value.Content.Get("application/json")
					if media == nil {
						return
					}
					for _, locale := range codes {
						example := media.Examples[locale]
						require.NotNil(t, example, locale)
						require.NoError(t, media.Schema.Value.VisitJSON(example.Value.Value), locale)
					}
				})
			}
		}
	}
}

func TestAdminWritesAcceptOnlySourceLanguageAndRejectUnknownLocale(t *testing.T) {
	spec := loadContract(t, "admin")
	for _, name := range []string{"CategoryUpsert", "CollectionUpsert", "FeatureUpsert", "MirrorUpsert", "ScreenshotCreate", "ScreenshotUpdate", "DesktopReleaseCreate", "DesktopReleaseUpdate"} {
		schema := spec.Components.Schemas[name].Value
		data, err := json.Marshal(schema.Example)
		require.NoError(t, err)
		var body map[string]any
		require.NoError(t, json.Unmarshal(data, &body))
		text := body["i18n"].(map[string]any)["zh-CN"]
		for _, locale := range localeCodes(t) {
			body["sourceLocale"] = locale
			body["i18n"] = map[string]any{locale: text}
			require.NoError(t, schema.VisitJSON(body), name+"/"+locale)
		}
		body["sourceLocale"] = "unknown"
		body["i18n"] = map[string]any{"unknown": text}
		require.Error(t, schema.VisitJSON(body), name)
	}
	require.True(t, spec.Paths.Value("/translations/approve").Post.Deprecated)
	require.Contains(t, spec.Components.Schemas["ReleaseSource"].Value.Enum, "editorial")
}
