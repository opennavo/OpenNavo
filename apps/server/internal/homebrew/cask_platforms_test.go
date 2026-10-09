package homebrew

import (
	"encoding/json"
	"io"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

func normalizedPlatforms(t *testing.T, raw json.RawMessage) (Package, CaskPlatformMetadata) {
	t.Helper()
	p, err := Normalize("cask", raw)
	require.NoError(t, err)
	var metadata CaskPlatformMetadata
	require.NoError(t, json.Unmarshal(p.Dependencies, &metadata))
	return p, metadata
}

func findPlatform(t *testing.T, metadata CaskPlatformMetadata, tag string) CaskPlatform {
	t.Helper()
	for _, platform := range metadata.Platforms {
		if platform.Tag == tag {
			return platform
		}
	}
	t.Fatalf("platform %s missing", tag)
	return CaskPlatform{}
}

func TestOfficialCaskPlatformRegressions(t *testing.T) {
	ray, metadata := normalizedPlatforms(t, fixture(t, "raycast"))
	require.True(t, ray.SupportsArm64 && ray.SupportsX8664)
	require.Equal(t, "known", metadata.SupportStatus)
	require.Equal(t, "1.104.31", findPlatform(t, metadata, "sequoia").Version)
	require.Equal(t, ray.Version, findPlatform(t, metadata, "arm64_golden_gate").Version)
	for _, platform := range metadata.Platforms {
		require.NotEqual(t, "golden_gate", platform.Tag)
	}
	artisan, metadata := normalizedPlatforms(t, fixture(t, "artisan"))
	require.Empty(t, artisan.MinMacos)
	require.Equal(t, "14", *findPlatform(t, metadata, "arm64_sonoma").MinMacos)
	require.Equal(t, "13", *findPlatform(t, metadata, "sonoma").MinMacos)
	_, metadata = normalizedPlatforms(t, fixture(t, "visual-studio-code"))
	require.Equal(t, "1.106.3", findPlatform(t, metadata, "big_sur").Version)
	require.NotEqual(t, *findPlatform(t, metadata, "sonoma").DownloadURL, *findPlatform(t, metadata, "arm64_sonoma").DownloadURL)
	_, metadata = normalizedPlatforms(t, fixture(t, "steam"))
	require.True(t, metadata.RequiresRosetta)
	require.True(t, findPlatform(t, metadata, "arm64_sonoma").RequiresRosetta)
	require.False(t, findPlatform(t, metadata, "sonoma").RequiresRosetta)
	drivers, metadata := normalizedPlatforms(t, fixture(t, "apple-hewlett-packard-printer-drivers"))
	require.Empty(t, drivers.MinMacos)
	require.Nil(t, metadata.Platforms[0].MinMacos)
	require.Equal(t, "<= 14", *metadata.Platforms[0].DependsOn.Macos)
}

func TestCaskSupportUnknownLinuxOnlyAndFuturePlatform(t *testing.T) {
	for _, test := range []struct {
		raw, status string
		arm, intel  bool
		count       int
	}{
		{`{"token":"unknown"}`, "unknown", false, false, 0},
		{`{"token":"intel","depends_on":{"arch":[{"type":"intel","bits":64}]}}`, "known", false, true, 0},
		{`{"token":"linux","supported_platforms":["arm64_linux","x86_64_linux"]}`, "known", false, false, 0},
		{`{"token":"none","supported_platforms":[]}`, "known", false, false, 0},
		{`{"token":"future","supported_platforms":["arm64_future"]}`, "unknown", false, false, 0},
		{`{"token":"both","supported_platforms":["sonoma","arm64_sonoma"],"depends_on":{"arch":[{"type":"arm","bits":64}]}}`, "known", true, true, 2},
	} {
		p, metadata := normalizedPlatforms(t, json.RawMessage(test.raw))
		require.Equal(t, test.status, metadata.SupportStatus)
		require.Equal(t, test.arm, p.SupportsArm64)
		require.Equal(t, test.intel, p.SupportsX8664)
		require.Len(t, metadata.Platforms, test.count)
	}
}

func TestCaskVariationsReplaceWholeFieldsAndKeepConstraints(t *testing.T) {
	raw := json.RawMessage(`{"token":"variant","version":"2","url":"https://example.com/base","sha256":"no_check","supported_platforms":["sonoma","arm64_sonoma"],"depends_on":{"formula":["shared"],"cask":["base"],"macos":{">=":["14"]}},"artifacts":[{"app":["Base.app"]}],"variations":{"sonoma":{"version":"1","url":null,"depends_on":{},"artifacts":[]},"arm64_sonoma":{"depends_on":{"formula":[{"openssl@3":">=3.4"}],"maximum_macos":{"<=":["15"]},"macos":{">":["12"],"!=":["13.1"]}}},"ventura":{"version":"unsupported"}}}`)
	before := string(raw)
	_, metadata := normalizedPlatforms(t, raw)
	intel := findPlatform(t, metadata, "sonoma")
	require.Equal(t, "1", intel.Version)
	require.Nil(t, intel.DownloadURL)
	require.Nil(t, intel.DownloadSHA256)
	require.Empty(t, intel.DependsOn.Requirements)
	require.Empty(t, intel.DependsOn.Casks)
	require.Empty(t, intel.Artifacts.Entries)
	arm := findPlatform(t, metadata, "arm64_sonoma")
	require.Equal(t, []string{"openssl@3"}, arm.DependsOn.Formulae)
	require.Empty(t, arm.DependsOn.Casks)
	require.Nil(t, arm.MinMacos)
	require.Equal(t, "!= 13.1; > 12; <= 15", *arm.DependsOn.Macos)
	require.JSONEq(t, `[{"openssl@3":">=3.4"}]`, string(arm.DependsOn.Requirements["formula"]))
	require.Equal(t, before, string(raw))
}

func TestCaskArtifactsPreserveTargetsScriptsUninstallAndUnknownTypes(t *testing.T) {
	raw := json.RawMessage(`{"token":"artifacts","artifacts":[{"app":["Source.app",{"target":"Renamed.app"}]},{"binary":["bin/tool",{"target":"$HOMEBREW_PREFIX/bin/renamed"}]},{"font":["Font.otf"]},{"suite":["Suite"]},{"input_method":["Input.app"]},{"installer":[{"script":{"executable":"install.sh","args":["--mode","user"],"sudo":false}}]},{"uninstall":[{"launchctl":["service.id"],"pkgutil":"package.id"}]},{"zap":[{"trash":["~/Library/Test"],"rmdir":"~/.test"}]},{"future_type":[{"nested":{"option":true}}]}]}`)
	p, _ := normalizedPlatforms(t, raw)
	var artifacts CaskArtifacts
	require.NoError(t, json.Unmarshal(p.Artifacts, &artifacts))
	require.Len(t, artifacts.Entries, 9)
	require.Equal(t, "Renamed.app", *artifacts.Entries[0].Target)
	require.Equal(t, []string{"renamed"}, artifacts.Binaries)
	require.Nil(t, artifacts.Entries[2].Target)
	require.JSONEq(t, `{"installer":[{"script":{"executable":"install.sh","args":["--mode","user"],"sudo":false}}]}`, string(marshal(artifacts.Entries[5].Declaration)))
	require.Equal(t, "uninstall", artifacts.Entries[6].Phase)
	require.Equal(t, "cleanup", artifacts.Entries[7].Phase)
	require.Equal(t, "future_type", artifacts.Entries[8].Type)
}

// An explicitly supplied public API snapshot tests all platform data through the production Go parser; routine tests use the fixed regression fixtures above.
func TestCaskLiveCatalogSnapshot(t *testing.T) {
	if os.Getenv("HOMEBREW_TEST_CATALOG") == "" {
		t.Skip("HOMEBREW_TEST_CATALOG not set")
	}
	file, err := os.Open("../../tmp/homebrew-compatibility-probe/catalog.json")
	require.NoError(t, err)
	t.Cleanup(func() { _ = file.Close() })
	decoder := json.NewDecoder(file)
	_, err = decoder.Token()
	require.NoError(t, err)
	casks, platforms, directives := 0, 0, 0
	for decoder.More() {
		var raw json.RawMessage
		require.NoError(t, decoder.Decode(&raw))
		var upstream Cask
		require.NoError(t, json.Unmarshal(raw, &upstream))
		p, metadata := normalizedPlatforms(t, raw)
		casks++
		expectedArm, expectedIntel := false, false
		for _, tag := range upstream.SupportedPlatforms {
			if tag == "arm64_linux" || tag == "x86_64_linux" {
				continue
			}
			variant := findPlatform(t, metadata, tag)
			expectedArm = expectedArm || variant.Arch == "arm64"
			expectedIntel = expectedIntel || variant.Arch == "x86_64"
			var fields map[string]json.RawMessage
			require.NoError(t, json.Unmarshal(raw, &fields))
			for key, value := range upstream.Variations[tag] {
				fields[key] = value
			}
			var effective Cask
			require.NoError(t, json.Unmarshal(marshal(fields), &effective))
			require.Equal(t, effective.Version, variant.Version, "%s:%s", p.Token, tag)
			require.Equal(t, effective.URL, stringValue(variant.DownloadURL), "%s:%s", p.Token, tag)
			require.Equal(t, variant.Arch == "arm64" && effective.RequiresRosetta, variant.RequiresRosetta)
			if effective.DependsOn == nil {
				effective.DependsOn = map[string]json.RawMessage{}
			}
			require.JSONEq(t, string(marshal(effective.DependsOn)), string(marshal(variant.DependsOn.Requirements)))
			entryIndex := 0
			for _, artifact := range effective.Artifacts {
				for key := range artifact {
					if key == "target" {
						continue
					}
					require.JSONEq(t, string(marshal(artifact)), string(marshal(variant.Artifacts.Entries[entryIndex].Declaration)))
					entryIndex++
				}
			}
			require.Len(t, variant.Artifacts.Entries, entryIndex)
			directives += entryIndex
			platforms++
		}
		require.Equal(t, expectedArm, p.SupportsArm64, p.Token)
		require.Equal(t, expectedIntel, p.SupportsX8664, p.Token)
		require.Equal(t, "known", metadata.SupportStatus, p.Token)
	}
	_, err = decoder.Token()
	require.NoError(t, err)
	var trailing any
	require.ErrorIs(t, decoder.Decode(&trailing), io.EOF)
	t.Logf("casks=%d platforms=%d declarations=%d", casks, platforms, directives)
}
