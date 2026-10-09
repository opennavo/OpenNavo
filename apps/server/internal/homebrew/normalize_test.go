package homebrew

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

func fixture(t *testing.T, token string) json.RawMessage {
	t.Helper()
	data, err := os.ReadFile("../../testdata/homebrew/" + token + ".json") // #nosec G304 -- Fixture names come only from fixed test parameters in this file.
	require.NoError(t, err)
	return data
}
func TestOfficialCaskMappings(t *testing.T) {
	item, err := Normalize("cask", fixture(t, "visual-studio-code"))
	require.NoError(t, err)
	require.Equal(t, "visual-studio-code", item.Token)
	require.Equal(t, "visual-studio-code", item.FullToken)
	require.Equal(t, "homebrew/cask", item.Tap)
	require.Equal(t, "Microsoft Visual Studio Code", item.Name)
	require.Equal(t, []string{"Microsoft Visual Studio Code", "VS Code", "visual-studio-code"}, item.Names)
	require.Equal(t, "1.140.0", item.Version)
	require.Equal(t, item.Version, item.VersionBase)
	require.True(t, item.AutoUpdates)
	require.True(t, item.SupportsArm64 && item.SupportsX8664)
	require.False(t, item.IsFont || item.KegOnly || item.Deprecated || item.Disabled)
	require.Equal(t, "Casks/v/visual-studio-code.rb", item.RubySourcePath)
	require.JSONEq(t, `{"apps":["Visual Studio Code.app"],"binaries":["code","code-tunnel"],"pkgs":[],"uninstall":[[{"launchctl":"com.microsoft.VSCode.ShipIt","quit":"com.microsoft.VSCode"}]]}`, legacyArtifacts(t, item.Artifacts))
	var metadata CaskPlatformMetadata
	require.NoError(t, json.Unmarshal(item.Dependencies, &metadata))
	require.JSONEq(t, `{"macos":{}}`, string(marshal(metadata.DependsOn)))
	require.Equal(t, CaskNormalizationVersion, metadata.NormalizationVersion)
	require.Len(t, metadata.Platforms, 14)
	var artifacts CaskArtifacts
	require.NoError(t, json.Unmarshal(item.Artifacts, &artifacts))
	require.Len(t, artifacts.Entries, 5)
	require.Equal(t, "/Applications/Visual Studio Code.app", *artifacts.Entries[1].Target)
	require.Equal(t, "cleanup", artifacts.Entries[4].Phase)
	require.JSONEq(t, `{}`, string(item.ConflictsWith))
	require.Equal(t, fixture(t, "visual-studio-code"), item.Raw)
	require.Len(t, item.RawHash, 64)
	wechat, err := Normalize("cask", fixture(t, "wechat"))
	require.NoError(t, err)
	require.Equal(t, "微信 Mac 版", wechat.ChineseName)
	require.Equal(t, "4.1.15.22", wechat.VersionBase)
	require.Equal(t, "12", wechat.MinMacos)
}

func TestOfficialFormulaMappings(t *testing.T) {
	item, err := Normalize("formula", fixture(t, "ripgrep"))
	require.NoError(t, err)
	require.Equal(t, "ripgrep", item.Token)
	require.Equal(t, "ripgrep", item.FullToken)
	require.Equal(t, "homebrew/core", item.Tap)
	require.Equal(t, "ripgrep", item.Name)
	require.Equal(t, "15.2.0", item.Version)
	require.Equal(t, "Unlicense", item.License)
	require.True(t, item.SupportsArm64 && item.SupportsX8664)
	require.False(t, item.AutoUpdates || item.KegOnly || item.IsFont)
	require.JSONEq(t, `{"binaries":["rg"]}`, legacyArtifacts(t, item.Artifacts))
	var dependencies struct {
		Runtime, Build, Test, Optional, Recommended []string
		UsesFromMacos                               []any
	}
	require.NoError(t, json.Unmarshal(item.Dependencies, &dependencies))
	require.Contains(t, dependencies.Runtime, "pcre2")
	require.Contains(t, dependencies.Build, "rust")
	require.Equal(t, []string{}, dependencies.Test)
	require.Equal(t, []string{}, dependencies.Optional)
	require.Equal(t, []string{}, dependencies.Recommended)
	require.JSONEq(t, `{"formulae":[],"reasons":[]}`, string(item.ConflictsWith))
	require.Equal(t, "Formula/r/ripgrep.rb", item.RubySourcePath)
}

func TestAllNonemptyMappingFieldsAndArchitectureVariants(t *testing.T) {
	metadata := `"tap":"custom/tap","desc":"description","homepage":"https://example.com","deprecated":true,"deprecation_date":"2026-01-01","deprecation_reason":"old","deprecation_replacement_cask":"new-app","disabled":true,"disable_date":"2026-02-01","disable_reason":"unsafe","disable_replacement_formula":"new-tool","caveats":"note","ruby_source_path":"Casks/f/font-test.rb","tap_git_head":"abcdef","generated_date":"2026-10-04"`
	raw := json.RawMessage(`{` + metadata + `,"token":"font-test","full_token":"custom/tap/font-test","name":["Font","字体","Font"],"old_tokens":["old-font"],"version":"2,42","auto_updates":true,"url":"https://example.com/font.zip","artifacts":[{"app":["Font.app"]},{"pkg":["font.pkg"]},{"binary":["/bin/tool"],"target":"/bin/newtool"},{"uninstall":[{"pkgutil":"id"}]}],"depends_on":{"arch":[{"type":"arm","bits":64}],"macos":{">=":["13"]}},"conflicts_with":{"cask":["other"]}}`)
	item, err := Normalize("cask", raw)
	require.NoError(t, err)
	require.Equal(t, Metadata{Tap: "custom/tap", Desc: "description", Homepage: "https://example.com", Deprecated: true, DeprecationDate: "2026-01-01", DeprecationReason: "old", DeprecationReplacementCask: "new-app", Disabled: true, DisableDate: "2026-02-01", DisableReason: "unsafe", DisableReplacementFormula: "new-tool", Caveats: "note", RubySourcePath: "Casks/f/font-test.rb", TapGitHead: "abcdef", GeneratedDate: "2026-10-04"}, item.Metadata)
	require.Equal(t, "cask:new-app", item.DeprecationReplacement)
	require.Equal(t, "formula:new-tool", item.DisableReplacement)
	require.Equal(t, []string{"Font", "字体", "old-font", "font-test"}, item.Names)
	require.Equal(t, []string{"old-font"}, item.OldTokens)
	require.Equal(t, "custom/tap/font-test", item.FullToken)
	require.Equal(t, "2", item.VersionBase)
	require.Equal(t, "https://example.com/font.zip", item.DownloadURL)
	require.True(t, item.IsFont && item.AutoUpdates && item.SupportsArm64)
	require.False(t, item.SupportsX8664)
	require.Equal(t, "13", item.MinMacos)
	require.JSONEq(t, `{"apps":["Font.app"],"binaries":["newtool"],"pkgs":["font.pkg"],"uninstall":[[{"pkgutil":"id"}]]}`, legacyArtifacts(t, item.Artifacts))
	require.JSONEq(t, `{"cask":["other"]}`, string(item.ConflictsWith))
	formula, err := Normalize("formula", json.RawMessage(`{`+metadata+`,"name":"tool","full_name":"custom/tap/tool","aliases":["alias","tool"],"oldnames":["old-tool"],"versions":{"stable":"3"},"license":{"any_of":["MIT","Apache-2.0"]},"urls":{"stable":{"url":"https://example.com/tool.tar.gz"}},"executables":["tool"],"dependencies":["runtime"],"build_dependencies":["build"],"test_dependencies":["test"],"optional_dependencies":["optional"],"recommended_dependencies":["recommended"],"uses_from_macos":["zlib"],"conflicts_with":["bad"],"conflicts_with_reasons":["same bin"],"keg_only":true,"bottle":{"stable":{"files":{"arm64_sonoma":{},"x86_64_linux":{}}}},"requirements":[{"name":"macos","version":"13"}]}`))
	require.NoError(t, err)
	require.Equal(t, item.Metadata, formula.Metadata)
	require.Equal(t, []string{"tool", "alias", "old-tool"}, formula.Names)
	require.Equal(t, []string{"old-tool"}, formula.OldTokens)
	require.Equal(t, "custom/tap/tool", formula.FullToken)
	require.Equal(t, `{"any_of":["MIT","Apache-2.0"]}`, formula.License)
	require.Equal(t, "https://example.com/tool.tar.gz", formula.DownloadURL)
	require.True(t, formula.KegOnly && formula.SupportsArm64)
	require.False(t, formula.SupportsX8664)
	require.Equal(t, "13", formula.MinMacos)
	require.JSONEq(t, `{"runtime":["runtime"],"build":["build"],"test":["test"],"optional":["optional"],"recommended":["recommended"],"usesFromMacos":["zlib"]}`, string(formula.Dependencies))
	require.JSONEq(t, `{"formulae":["bad"],"reasons":["same bin"]}`, string(formula.ConflictsWith))
	for _, example := range []struct {
		Kind, Raw  string
		Arm, Intel bool
	}{
		{"cask", `{"token":"intel","depends_on":{"arch":[{"type":"intel","bits":64}]}}`, false, true},
		{"cask", `{"token":"empty"}`, false, false},
		{"formula", `{"name":"source","versions":{"head":"HEAD"}}`, true, true},
		{"formula", `{"name":"intel","bottle":{"stable":{"files":{"sonoma":{},"x86_64_linux":{}}}}}`, false, true},
	} {
		p, err := Normalize(example.Kind, json.RawMessage(example.Raw))
		require.NoError(t, err)
		require.Equal(t, example.Arm, p.SupportsArm64)
		require.Equal(t, example.Intel, p.SupportsX8664)
	}
}

func TestCanonicalHashIgnoresOnlyVolatileFields(t *testing.T) {
	first, err := RawHash(json.RawMessage(`{"token":"tool","depends_on":{"b":2,"a":1},"tap_git_head":"a","generated_date":"a","analytics":{},"installed":[],"installed_time":1,"outdated":false,"pinned":false,"pinned_version":"1"}`))
	require.NoError(t, err)
	second, err := RawHash(json.RawMessage(`{"depends_on":{"a":1,"b":2},"token":"tool","tap_git_head":"b"}`))
	require.NoError(t, err)
	require.Equal(t, first, second)
	third, err := RawHash(json.RawMessage(`{"token":"tool","depends_on":{"a":1,"b":3}}`))
	require.NoError(t, err)
	require.NotEqual(t, first, third)
	for _, raw := range []string{`null`, `invalid`, `{"a":1} trailing`} {
		_, err := RawHash(json.RawMessage(raw))
		require.Error(t, err)
	}
	for _, example := range []struct{ Kind, Raw string }{{"unknown", `{}`}, {"cask", `{}`}, {"cask", `{"token":"; rm"}`}, {"formula", `{"name":9}`}, {"cask", `{"token":9}`}} {
		_, err := Normalize(example.Kind, json.RawMessage(example.Raw))
		require.Error(t, err)
	}
}

func legacyArtifacts(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	var artifacts map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(raw, &artifacts))
	delete(artifacts, "entries")
	return string(marshal(artifacts))
}
