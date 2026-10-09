// Package about validates admin About configuration and reads content using the public API language fallback order.
package about

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/opennavo/opennavo/server/gen/publicapi"
	"github.com/opennavo/opennavo/server/internal/i18n"
)

const Key = "site.about"

type Config struct {
	SourceLocale string                              `json:"sourceLocale,omitempty"`
	Locales      map[string][]publicapi.AboutSection `json:"locales"`
	Modules      []publicapi.OpenSourceModule        `json:"modules"`
}

func Parse(raw []byte) (Config, error) {
	var c Config
	if err := json.Unmarshal(raw, &c); err != nil {
		return c, err
	}
	if !i18n.Valid(c.SourceLanguage()) || len(c.Locales[c.SourceLanguage()]) == 0 || len(c.Locales["en-US"]) == 0 || c.Modules == nil {
		return c, errors.New("about content requires a supported source language, English and modules")
	}
	for locale, sections := range c.Locales {
		if !i18n.Valid(locale) {
			return c, errors.New("unsupported about locale")
		}
		seen := map[string]bool{}
		for _, section := range sections {
			if strings.TrimSpace(section.Key) == "" || strings.TrimSpace(section.Title) == "" || section.Paragraphs == nil || seen[section.Key] {
				return c, errors.New("invalid about section")
			}
			seen[section.Key] = true
		}
		if !seen["openSource"] {
			return c, errors.New("openSource section is required")
		}
	}
	for _, m := range c.Modules {
		u, err := url.Parse(m.Url)
		if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || strings.TrimSpace(m.Name) == "" || strings.TrimSpace(m.Version) == "" || strings.TrimSpace(m.License) == "" || strings.TrimSpace(m.Ecosystem) == "" {
			return c, errors.New("invalid open source module")
		}
	}
	return c, nil
}

// SourceLanguage preserves explicit provenance; new configurations default to English.
func (c Config) SourceLanguage() string {
	if c.SourceLocale != "" {
		return c.SourceLocale
	}
	return string(i18n.AuthoringLocale)
}

func (c Config) Localized(locale string) *publicapi.AboutContent {
	sections := c.Locales[locale]
	if len(sections) == 0 {
		sections = c.Locales["en-US"]
	}
	sections = append([]publicapi.AboutSection(nil), sections...)
	for i, section := range sections {
		if section.Key == "openSource" {
			for _, english := range c.Locales["en-US"] {
				if english.Key == "openSource" {
					sections[i] = english
					break
				}
			}
		}
	}
	return &publicapi.AboutContent{Sections: sections, Modules: c.Modules}
}

// SourceFields excludes the open-source inventory and explanation, which stay in English and never enter the model.
func (c Config) SourceFields() map[string]string {
	fields := map[string]string{}
	for _, section := range c.Locales[c.SourceLanguage()] {
		if section.Key == "openSource" {
			continue
		}
		fields[section.Key+".title"] = section.Title
		for i, paragraph := range section.Paragraphs {
			if strings.TrimSpace(paragraph) != "" {
				fields[fmt.Sprintf("%s.%d", section.Key, i)] = paragraph
			}
		}
	}
	return fields
}
func (c Config) SourceHash() string {
	locale := c.SourceLanguage()
	sections := c.Locales[locale]
	// Keep the original Chinese-source hash so jobs queued before the locale migration
	// remain valid. Other languages include their locale and cannot reuse those jobs.
	var payload any = sections
	if locale != "zh-CN" {
		payload = struct {
			Locale   string
			Sections []publicapi.AboutSection
		}{locale, sections}
	}
	raw, _ := json.Marshal(payload)
	return fmt.Sprintf("%x", sha256.Sum256(raw))
}
func (c *Config) ApplyTranslations(output map[string]map[string]string) {
	for locale, fields := range output {
		sections := make([]publicapi.AboutSection, 0, len(c.Locales[c.SourceLanguage()]))
		for _, section := range c.Locales[c.SourceLanguage()] {
			if section.Key == "openSource" {
				for _, english := range c.Locales["en-US"] {
					if english.Key == "openSource" {
						section = english
						break
					}
				}
			} else {
				section.Title = fields[section.Key+".title"]
				paragraphs := make([]string, len(section.Paragraphs))
				for i := range paragraphs {
					paragraphs[i] = fields[fmt.Sprintf("%s.%d", section.Key, i)]
				}
				section.Paragraphs = paragraphs
			}
			sections = append(sections, section)
		}
		c.Locales[locale] = sections
	}
}
