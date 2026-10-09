package about

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"testing"

	"github.com/opennavo/opennavo/server/gen/publicapi"
	"github.com/stretchr/testify/require"
)

func TestSourceLanguageDefaultsToEnglishAndPreservesExplicitSource(t *testing.T) {
	english := publicapi.AboutSection{Key: "about", Title: "About", Paragraphs: []string{"English source"}}
	chinese := publicapi.AboutSection{Key: "about", Title: "关于", Paragraphs: []string{"中文原文"}}
	for _, source := range []string{"", "zh-CN"} {
		t.Run(source, func(t *testing.T) {
			c := Config{SourceLocale: source, Locales: map[string][]publicapi.AboutSection{"en-US": {english}, "zh-CN": {chinese}}}
			want := "en-US"
			if source != "" {
				want = source
			}
			require.Equal(t, want, c.SourceLanguage())
			require.Equal(t, c.Locales[want][0].Title, c.SourceFields()["about.title"])
			hash := c.SourceHash()
			other := "zh-CN"
			if want == other {
				other = "en-US"
			}
			c.Locales[other][0].Title = "Changed translation"
			require.Equal(t, hash, c.SourceHash())
			c.ApplyTranslations(map[string]map[string]string{"ja-JP": {"about.title": "日本語", "about.0": "説明"}})
			require.Equal(t, c.Locales[want][0].Title, c.SourceFields()["about.title"])
			require.Equal(t, "日本語", c.Locales["ja-JP"][0].Title)
		})
	}
}

func TestSourceHashIncludesLanguage(t *testing.T) {
	section := publicapi.AboutSection{Key: "brand", Title: "OpenNavo", Paragraphs: []string{"OpenNavo"}}
	c := Config{SourceLocale: "en-US", Locales: map[string][]publicapi.AboutSection{"en-US": {section}, "zh-CN": {section}}}
	english := c.SourceHash()
	c.SourceLocale = "zh-CN"
	require.NotEqual(t, english, c.SourceHash())
}

func TestChineseSourceHashPreservesQueuedLegacyJobs(t *testing.T) {
	sections := []publicapi.AboutSection{{Key: "about", Title: "OpenNavo", Paragraphs: []string{"Source text"}}}
	raw, err := json.Marshal(sections)
	require.NoError(t, err)
	legacyHash := fmt.Sprintf("%x", sha256.Sum256(raw))
	c := Config{SourceLocale: "zh-CN", Locales: map[string][]publicapi.AboutSection{"zh-CN": sections, "en-US": sections, "ja-JP": sections}}
	require.Equal(t, legacyHash, c.SourceHash())
	for _, locale := range []string{"en-US", "ja-JP"} {
		c.SourceLocale = locale
		require.NotEqual(t, legacyHash, c.SourceHash(), "Changing source language must invalidate a legacy job")
	}
	c.SourceLocale = "zh-CN"
	c.Locales["zh-CN"][0].Title = "Changed source"
	require.NotEqual(t, legacyHash, c.SourceHash(), "Changing source text must invalidate a legacy job")
}

func TestSeedAndLocaleFallback(t *testing.T) {
	raw, err := os.ReadFile("../../seeds/about.json")
	require.NoError(t, err)
	c, err := Parse(raw)
	require.NoError(t, err)
	require.Len(t, c.Locales, 6)
	require.Greater(t, len(c.Modules), 3000)
	require.Equal(t, c.Locales["en-US"], c.Localized("unknown").Sections)
	localized := c.Localized("zh-CN").Sections
	require.Equal(t, c.Locales["zh-CN"][:5], localized[:5])
	require.Equal(t, "Open source", localized[5].Title)
	require.Equal(t, c.Locales["en-US"][5].Paragraphs, localized[5].Paragraphs)
	for key := range c.SourceFields() {
		require.NotContains(t, key, "openSource")
	}
	require.Equal(t, c.Modules, c.Localized("ja-JP").Modules)
}

func TestRejectInvalidConfig(t *testing.T) {
	raw, err := os.ReadFile("../../seeds/about.json")
	require.NoError(t, err)
	for _, mutate := range []func(*Config){
		func(c *Config) { delete(c.Locales, "en-US") },
		func(c *Config) { c.Modules[0].Url = "javascript:alert(1)" },
		func(c *Config) { c.Modules[0].Url = "https://user:password@example.com" },
		func(c *Config) { c.Locales["zh-CN"][1].Key = c.Locales["zh-CN"][0].Key },
		func(c *Config) { c.Modules = nil },
	} {
		c, err := Parse(raw)
		require.NoError(t, err)
		mutate(&c)
		changed, err := json.Marshal(c)
		require.NoError(t, err)
		_, err = Parse(changed)
		require.Error(t, err)
	}
}
