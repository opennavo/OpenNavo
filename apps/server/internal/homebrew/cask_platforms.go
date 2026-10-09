package homebrew

import (
	"encoding/json"
	"fmt"
	"path"
	"regexp"
	"slices"
	"strings"
)

// Normalization rules are independent of raw hashes, so upstream 304 responses cannot preserve incorrect derived fields forever.
const CaskNormalizationVersion = 2

type CaskArtifact struct {
	Type        string                     `json:"type"`
	Phase       string                     `json:"phase"`
	Sources     []string                   `json:"sources"`
	Target      *string                    `json:"target"`
	Declaration map[string]json.RawMessage `json:"declaration"`
}

type CaskArtifacts struct {
	Apps      []string          `json:"apps"`
	Binaries  []string          `json:"binaries"`
	Pkgs      []string          `json:"pkgs"`
	Uninstall []json.RawMessage `json:"uninstall"`
	Entries   []CaskArtifact    `json:"entries"`
}

type CaskRequirements struct {
	Macos        *string                    `json:"macos"`
	Arch         []string                   `json:"arch"`
	Formulae     []string                   `json:"formulae"`
	Casks        []string                   `json:"casks"`
	Requirements map[string]json.RawMessage `json:"requirements"`
}

type CaskPlatform struct {
	Tag             string           `json:"tag"`
	Macos           string           `json:"macos"`
	Arch            string           `json:"arch"`
	Version         string           `json:"version"`
	DownloadURL     *string          `json:"downloadUrl"`
	DownloadSHA256  *string          `json:"downloadSha256"`
	MinMacos        *string          `json:"minMacos"`
	RequiresRosetta bool             `json:"requiresRosetta"`
	DependsOn       CaskRequirements `json:"dependsOn"`
	Artifacts       CaskArtifacts    `json:"artifacts"`
	ConflictsWith   json.RawMessage  `json:"conflictsWith"`
}

type CaskPlatformMetadata struct {
	NormalizationVersion int                        `json:"normalizationVersion"`
	DependsOn            map[string]json.RawMessage `json:"dependsOn"`
	SupportStatus        string                     `json:"supportStatus"`
	RequiresRosetta      bool                       `json:"requiresRosetta"`
	Platforms            []CaskPlatform             `json:"platforms"`
}

// Labels come from Homebrew MacOSVersion::RELEASES; they identify platforms, not minimum application OS requirements.
var macosReleases = map[string]string{
	"golden_gate": "27", "tahoe": "26", "sequoia": "15", "sonoma": "14", "ventura": "13",
	"monterey": "12", "big_sur": "11", "catalina": "10.15", "mojave": "10.14",
	"high_sierra": "10.13", "sierra": "10.12", "el_capitan": "10.11", "yosemite": "10.10",
	"mavericks": "10.9", "mountain_lion": "10.8", "lion": "10.7", "snow_leopard": "10.6",
	"leopard": "10.5", "tiger": "10.4",
}

var checksumPattern = regexp.MustCompile(`^[a-fA-F0-9]{64}$`)
var systemVersionPattern = regexp.MustCompile(`^[0-9]+(?:\.[0-9]+)*$`)

func nullableString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func declaredArchitectures(on map[string]json.RawMessage) (arm, intel bool) {
	var architectures []struct {
		Type string `json:"type"`
		Bits int    `json:"bits"`
	}
	if json.Unmarshal(on["arch"], &architectures) != nil {
		return false, false
	}
	for _, architecture := range architectures {
		arm = arm || (architecture.Type == "arm" && architecture.Bits == 64)
		intel = intel || (architecture.Type == "intel" && architecture.Bits == 64)
	}
	return arm, intel
}

func caskPlatforms(cask Cask, raw json.RawMessage) (CaskPlatformMetadata, error) {
	out := CaskPlatformMetadata{NormalizationVersion: CaskNormalizationVersion, DependsOn: cask.DependsOn,
		SupportStatus: "known", RequiresRosetta: cask.RequiresRosetta, Platforms: []CaskPlatform{}}
	if out.DependsOn == nil {
		out.DependsOn = map[string]json.RawMessage{}
	}
	if cask.SupportedPlatforms == nil {
		arm, intel := declaredArchitectures(cask.DependsOn)
		if !arm && !intel {
			out.SupportStatus = "unknown"
		}
		return out, nil
	}
	var base map[string]json.RawMessage
	if err := json.Unmarshal(raw, &base); err != nil {
		return out, fmt.Errorf("decode cask platform base: %w", err)
	}
	for _, tag := range unique(cask.SupportedPlatforms) {
		if tag == "linux" || strings.HasSuffix(tag, "_linux") {
			continue
		}
		arch, release := "x86_64", tag
		if strings.HasPrefix(tag, "arm64_") {
			arch, release = "arm64", strings.TrimPrefix(tag, "arm64_")
		}
		macos, known := macosReleases[release]
		if !known {
			out.SupportStatus = "unknown"
			continue
		}
		effective := make(map[string]json.RawMessage, len(base))
		for key, value := range base {
			effective[key] = value
		}
		// Homebrew API.merge_variations uses shallow overrides; empty objects, empty arrays and null must clear base fields.
		for key, value := range cask.Variations[tag] {
			effective[key] = value
		}
		var variant Cask
		if err := json.Unmarshal(marshal(effective), &variant); err != nil {
			return out, fmt.Errorf("decode cask variation %s: %w", tag, err)
		}
		var checksum *string
		if checksumPattern.MatchString(variant.SHA256) {
			checksum = &variant.SHA256
		}
		out.Platforms = append(out.Platforms, CaskPlatform{Tag: tag, Macos: macos, Arch: arch, Version: variant.Version,
			DownloadURL: nullableString(variant.URL), DownloadSHA256: checksum, MinMacos: nullableString(minimumMacos(variant.DependsOn)),
			RequiresRosetta: arch == "arm64" && variant.RequiresRosetta, DependsOn: Requirements(variant.DependsOn, []string{arch}),
			Artifacts: normalizeArtifacts(variant.Artifacts), ConflictsWith: normalizeCaskConflicts(variant.ConflictsWith)})
		out.RequiresRosetta = out.RequiresRosetta || variant.RequiresRosetta
	}
	return out, nil
}

func minimumMacos(on map[string]json.RawMessage) string {
	var comparisons map[string][]string
	if json.Unmarshal(on["macos"], &comparisons) != nil {
		return ""
	}
	var minimum string
	for _, operator := range []string{">=", "==", "="} {
		versions := comparisons[operator]
		if len(versions) == 0 {
			continue
		}
		for _, version := range versions {
			if !systemVersionPattern.MatchString(version) {
				return ""
			}
			comparison, _ := CompareVersion(version, minimum)
			if minimum == "" || comparison < 0 {
				minimum = version
			}
		}
		return minimum
	}
	return ""
}

// Preserve full conditions while providing name and OS requirement summaries readable by older clients.
func Requirements(on map[string]json.RawMessage, arch []string) CaskRequirements {
	if on == nil {
		on = map[string]json.RawMessage{}
	}
	conditions := []string{}
	for _, field := range []string{"macos", "maximum_macos"} {
		var comparisons map[string][]string
		if json.Unmarshal(on[field], &comparisons) != nil {
			continue
		}
		operators := make([]string, 0, len(comparisons))
		for operator := range comparisons {
			operators = append(operators, operator)
		}
		slices.Sort(operators)
		for _, operator := range operators {
			if versions := comparisons[operator]; len(versions) > 0 {
				conditions = append(conditions, operator+" "+strings.Join(versions, " / "))
			}
		}
	}
	return CaskRequirements{Macos: nullableString(strings.Join(conditions, "; ")), Arch: unique(arch),
		Formulae: dependencyNames(on["formula"]), Casks: dependencyNames(on["cask"]), Requirements: on}
}

func dependencyNames(raw json.RawMessage) []string {
	var items []json.RawMessage
	if json.Unmarshal(raw, &items) != nil {
		return []string{}
	}
	result := []string{}
	for _, item := range items {
		var name string
		if json.Unmarshal(item, &name) == nil {
			result = append(result, name)
			continue
		}
		var constraints map[string]json.RawMessage
		if json.Unmarshal(item, &constraints) == nil {
			keys := make([]string, 0, len(constraints))
			for key := range constraints {
				keys = append(keys, key)
			}
			slices.Sort(keys)
			result = append(result, keys...)
		}
	}
	return unique(result)
}

func normalizeArtifacts(artifacts []map[string]json.RawMessage) CaskArtifacts {
	out := CaskArtifacts{Apps: []string{}, Binaries: []string{}, Pkgs: []string{}, Uninstall: []json.RawMessage{}, Entries: []CaskArtifact{}}
	for _, declaration := range artifacts {
		keys := make([]string, 0, len(declaration))
		for key := range declaration {
			if key != "target" {
				keys = append(keys, key)
			}
		}
		slices.Sort(keys)
		for _, kind := range keys {
			entry := CaskArtifact{Type: kind, Phase: "install", Sources: []string{}, Declaration: declaration}
			if kind == "zap" {
				entry.Phase = "cleanup"
			} else if strings.HasPrefix(kind, "uninstall") {
				entry.Phase = "uninstall"
			}
			var target string
			_ = json.Unmarshal(declaration["target"], &target)
			var args []json.RawMessage
			if json.Unmarshal(declaration[kind], &args) != nil {
				args = []json.RawMessage{declaration[kind]}
			}
			for _, arg := range args {
				var source string
				if json.Unmarshal(arg, &source) == nil {
					entry.Sources = append(entry.Sources, source)
					continue
				}
				var options map[string]json.RawMessage
				if target == "" && json.Unmarshal(arg, &options) == nil {
					_ = json.Unmarshal(options["target"], &target)
				}
			}
			entry.Target = nullableString(target)
			out.Entries = append(out.Entries, entry)
			switch kind {
			case "app":
				out.Apps = append(out.Apps, entry.Sources...)
			case "pkg":
				out.Pkgs = append(out.Pkgs, entry.Sources...)
			case "binary":
				for _, source := range entry.Sources {
					if target != "" {
						source = target
					}
					out.Binaries = append(out.Binaries, path.Base(source))
				}
			case "uninstall":
				out.Uninstall = append(out.Uninstall, declaration[kind])
			}
		}
	}
	out.Apps, out.Binaries, out.Pkgs = unique(out.Apps), unique(out.Binaries), unique(out.Pkgs)
	return out
}

func normalizeCaskConflicts(raw json.RawMessage) json.RawMessage {
	var conflicts map[string]json.RawMessage
	_ = json.Unmarshal(raw, &conflicts)
	return marshal(map[string]any{"casks": dependencyNames(conflicts["cask"]), "formulae": dependencyNames(conflicts["formula"])})
}
