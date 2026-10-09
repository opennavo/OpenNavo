package seeds

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"time"
)

//go:embed e2e.json
var e2eData []byte

type E2EPackage struct {
	Kind, Token, Name, DisplayName, Summary, Category, Version, Homepage string
	Artifacts                                                            json.RawMessage
	Aliases                                                              []string
	DownloadURL                                                          string `json:"downloadUrl"`
	DownloadSize                                                         int64  `json:"downloadSize"`
	SHA256                                                               string `json:"sha256"`
	SourcePath                                                           string `json:"ruby_source_path"`
	License, Caveats, Developer, RepoURL                                 string
	Dependencies, ConflictsWith                                          json.RawMessage
}

type E2EAsset struct {
	Token, Kind, Key, URL, MIME, SHA256, Theme, CaptionZH, CaptionEN string
	Width, Height                                                    int
	Bytes                                                            int64
}
type E2EDesktopRelease struct {
	Version, NotesZH, NotesEN string
	PubDate                   time.Time
	Artifacts                 json.RawMessage
}
type E2ERelease struct {
	Token, Version, Status, Summary, BodyEN, BodyZH, Source string
	PublishedAt                                             time.Time
	Sections                                                json.RawMessage
}
type E2EFeedback struct{ Type, Token, Content, Platform, Status string }
type E2EData struct {
	Packages   []E2EPackage
	Releases   []E2ERelease
	Collection []string
	Synonyms   [][]string
	Feedback   []E2EFeedback
	Media      []E2EAsset          `json:"-"`
	Desktop    []E2EDesktopRelease `json:"-"`
	SearchDate time.Time           `json:"-"`
}
type E2EAccount struct{ Username, Role string }

func E2EAccounts() []E2EAccount {
	return []E2EAccount{{"e2e-super", "R_SUPER"}, {"e2e-admin", "R_ADMIN"}, {"e2e-editor", "R_EDITOR"}, {"e2e-reviewer", "R_REVIEWER"}, {"e2e-ops", "R_OPS"}}
}
func LoadE2E() (E2EData, error) {
	var data E2EData
	if err := json.Unmarshal(e2eData, &data); err != nil {
		return data, fmt.Errorf("parse embedded e2e fixtures: %w", err)
	}
	return data, nil
}
