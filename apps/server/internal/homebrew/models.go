package homebrew

import "encoding/json"

type Metadata struct {
	Tap                           string `json:"tap"`
	Desc                          string `json:"desc"`
	Homepage                      string `json:"homepage"`
	Deprecated                    bool   `json:"deprecated"`
	DeprecationDate               string `json:"deprecation_date"`
	DeprecationReason             string `json:"deprecation_reason"`
	DeprecationReplacementCask    string `json:"deprecation_replacement_cask"`
	DeprecationReplacementFormula string `json:"deprecation_replacement_formula"`
	Disabled                      bool   `json:"disabled"`
	DisableDate                   string `json:"disable_date"`
	DisableReason                 string `json:"disable_reason"`
	DisableReplacementCask        string `json:"disable_replacement_cask"`
	DisableReplacementFormula     string `json:"disable_replacement_formula"`
	Caveats                       string `json:"caveats"`
	RubySourcePath                string `json:"ruby_source_path"`
	TapGitHead                    string `json:"tap_git_head"`
	GeneratedDate                 string `json:"generated_date"`
}

type Cask struct {
	Metadata
	Token              string                                `json:"token"`
	FullToken          string                                `json:"full_token"`
	OldTokens          []string                              `json:"old_tokens"`
	Names              []string                              `json:"name"`
	Version            string                                `json:"version"`
	AutoUpdates        bool                                  `json:"auto_updates"`
	URL                string                                `json:"url"`
	Artifacts          []map[string]json.RawMessage          `json:"artifacts"`
	DependsOn          map[string]json.RawMessage            `json:"depends_on"`
	ConflictsWith      json.RawMessage                       `json:"conflicts_with"`
	SHA256             string                                `json:"sha256"`
	RequiresRosetta    bool                                  `json:"caveats_rosetta"`
	SupportedPlatforms []string                              `json:"supported_platforms"`
	Variations         map[string]map[string]json.RawMessage `json:"variations"`
}

type Formula struct {
	Metadata
	Name     string   `json:"name"`
	FullName string   `json:"full_name"`
	Aliases  []string `json:"aliases"`
	OldNames []string `json:"oldnames"`
	Versions struct {
		Stable string `json:"stable"`
		Head   string `json:"head"`
	} `json:"versions"`
	License json.RawMessage `json:"license"`
	URLs    struct {
		Stable struct {
			URL string `json:"url"`
		} `json:"stable"`
	} `json:"urls"`
	Executables             []string        `json:"executables"`
	Dependencies            []string        `json:"dependencies"`
	BuildDependencies       []string        `json:"build_dependencies"`
	TestDependencies        []string        `json:"test_dependencies"`
	OptionalDependencies    []string        `json:"optional_dependencies"`
	RecommendedDependencies []string        `json:"recommended_dependencies"`
	UsesFromMacos           json.RawMessage `json:"uses_from_macos"`
	ConflictsWith           []string        `json:"conflicts_with"`
	ConflictsWithReasons    []string        `json:"conflicts_with_reasons"`
	KegOnly                 bool            `json:"keg_only"`
	Bottle                  struct {
		Stable struct {
			Files map[string]json.RawMessage `json:"files"`
		} `json:"stable"`
	} `json:"bottle"`
	Requirements []struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	} `json:"requirements"`
}

type Package struct {
	Metadata
	Kind, Token, FullToken, Name, Version, VersionBase         string
	Names, OldTokens                                           []string
	License                                                    string
	AutoUpdates, KegOnly, SupportsArm64, SupportsX8664, IsFont bool
	DownloadURL, MinMacos, ChineseName                         string
	DeprecationReplacement, DisableReplacement                 string
	Artifacts, Dependencies, ConflictsWith                     json.RawMessage
	Raw                                                        json.RawMessage
	RawHash                                                    string
}
