package catalog

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/opennavo/opennavo/server/internal/homebrew"
	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/stretchr/testify/require"
)

func TestCatalogSpoolFullScalePreservesPlatformData(t *testing.T) {
	const count = 7776
	var definitions []map[string]json.RawMessage
	var expected []homebrew.Package
	for _, name := range []string{"raycast", "artisan", "steam", "apple-hewlett-packard-printer-drivers"} {
		raw, err := os.ReadFile(filepath.Join("../../../testdata/homebrew", name+".json")) // #nosec G304 -- Filenames come from the fixed fixture list above.
		require.NoError(t, err)
		var definition map[string]json.RawMessage
		require.NoError(t, json.Unmarshal(raw, &definition))
		definitions = append(definitions, definition)
		item, err := homebrew.Normalize("cask", raw)
		require.NoError(t, err)
		expected = append(expected, item)
	}
	spool, err := newCatalogSpool()
	require.NoError(t, err)
	t.Cleanup(func() { _ = spool.close() })
	var expandedBytes int
	for i := range count {
		definition := definitions[i%len(definitions)]
		definition["token"] = json.RawMessage(fmt.Sprintf(`"spool-%d"`, i))
		raw, err := json.Marshal(definition)
		require.NoError(t, err)
		require.NoError(t, spool.append(raw))
		data, err := json.Marshal(expected[i%len(expected)])
		require.NoError(t, err)
		expandedBytes += len(data) + 1
	}
	require.Greater(t, expandedBytes, 64<<20, "The fixture must trigger the old 64 MiB spool failure")
	require.NoError(t, spool.rewind())
	info, err := spool.file.Stat()
	require.NoError(t, err)
	require.Less(t, info.Size(), int64(64<<20), "The spool must fit the existing production tmpfs")
	for i := range count {
		item, err := spool.next()
		require.NoError(t, err)
		want := expected[i%len(expected)]
		require.Equal(t, fmt.Sprintf("spool-%d", i), item.Token)
		require.Equal(t, want.Dependencies, item.Dependencies)
		require.Equal(t, want.Artifacts, item.Artifacts)
		require.Equal(t, want.Version, item.Version)
		hash, err := homebrew.RawHash(item.Raw)
		require.NoError(t, err)
		require.Equal(t, hash, item.RawHash)
	}
	_, err = spool.next()
	require.ErrorIs(t, err, io.EOF)
	t.Logf("items=%d expandedBytes=%d spoolBytes=%d", count, expandedBytes, info.Size())
	name := spool.file.Name()
	require.NoError(t, spool.close())
	_, err = os.Stat(name)
	require.ErrorIs(t, err, os.ErrNotExist)
}

func TestCatalogSpoolFlushAndTruncationErrors(t *testing.T) {
	t.Run("flush_failure", func(t *testing.T) {
		spool, err := newCatalogSpool()
		require.NoError(t, err)
		t.Cleanup(func() { _ = spool.close() })
		require.NoError(t, spool.append(json.RawMessage(`{"token":"one","version":"1"}`)))
		require.NoError(t, spool.file.Close())
		require.ErrorIs(t, spool.rewind(), os.ErrClosed)
		require.Nil(t, spool.decoder, "Failed compression finalization must prevent readback or persistence")
	})
	t.Run("truncated_footer", func(t *testing.T) {
		spool, err := newCatalogSpool()
		require.NoError(t, err)
		t.Cleanup(func() { _ = spool.close() })
		require.NoError(t, spool.append(json.RawMessage(`{"token":"one","version":"1"}`)))
		require.NoError(t, spool.writer.Close())
		info, err := spool.file.Stat()
		require.NoError(t, err)
		require.NoError(t, spool.file.Truncate(info.Size()-4))
		require.NoError(t, spool.rewind())
		for range 2 {
			_, err = spool.next()
			if err != nil {
				break
			}
		}
		require.ErrorIs(t, err, io.ErrUnexpectedEOF)
		require.False(t, errors.Is(err, io.EOF), "A corrupt spool must not be treated as normal end-of-catalog")
	})
}

// Optional offline full replay; CI uses the fixed full-scale fixture above and does not depend on live upstream data.
func TestCatalogSpoolCapturedCatalog(t *testing.T) {
	path := os.Getenv("OPENNAVO_CATALOG_REPLAY")
	if path == "" {
		t.Skip("set OPENNAVO_CATALOG_REPLAY to a captured cask.json")
	}
	root, err := os.OpenRoot(filepath.Dir(path))
	require.NoError(t, err)
	t.Cleanup(func() { _ = root.Close() })
	input, err := root.Open(filepath.Base(path))
	require.NoError(t, err)
	t.Cleanup(func() { _ = input.Close() })
	decoder := json.NewDecoder(input)
	token, err := decoder.Token()
	require.NoError(t, err)
	require.Equal(t, json.Delim('['), token)
	spool, err := newCatalogSpool()
	require.NoError(t, err)
	t.Cleanup(func() { _ = spool.close() })
	expected := map[string]string{}
	for decoder.More() {
		var raw json.RawMessage
		require.NoError(t, decoder.Decode(&raw))
		item, err := homebrew.Normalize("cask", raw)
		require.NoError(t, err)
		expected[item.Token] = item.RawHash
		require.NoError(t, spool.append(item.Raw))
	}
	require.NoError(t, spool.rewind())
	info, err := spool.file.Stat()
	require.NoError(t, err)
	count := 0
	for {
		item, err := spool.next()
		if errors.Is(err, io.EOF) {
			break
		}
		require.NoError(t, err)
		require.Equal(t, expected[item.Token], item.RawHash)
		delete(expected, item.Token)
		count++
	}
	require.Empty(t, expected)
	require.Positive(t, count)
	require.Less(t, info.Size(), int64(64<<20))
	t.Logf("items=%d spoolBytes=%d", count, info.Size())
}

func TestUnchangedEntryMatchesTheFullComparison(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("../../../testdata/homebrew", "steam.json")) // #nosec G304 -- Fixed fixture path.
	require.NoError(t, err)
	item, err := homebrew.Normalize("cask", raw)
	require.NoError(t, err)
	stored := func(mutate func(*store.CatalogRow)) map[string]*store.CatalogRow {
		row := &store.CatalogRow{ID: 1, Kind: "cask", Token: item.Token, RawHash: item.RawHash, NormalizationVersion: fmt.Sprint(homebrew.CaskNormalizationVersion)}
		if mutate != nil {
			mutate(row)
		}
		return map[string]*store.CatalogRow{item.Token: row}
	}
	require.True(t, unchangedEntry(stored(nil), raw))
	require.False(t, unchangedEntry(map[string]*store.CatalogRow{}, raw), "new token")
	require.False(t, unchangedEntry(stored(func(row *store.CatalogRow) { row.RawHash = "changed" }), raw), "changed definition")
	removed := time.Now()
	require.False(t, unchangedEntry(stored(func(row *store.CatalogRow) { row.RemovedAt = &removed }), raw), "restored package")
	require.False(t, unchangedEntry(stored(func(row *store.CatalogRow) { row.NormalizationVersion = "1" }), raw), "outdated normalization")
	require.False(t, unchangedEntry(stored(nil), json.RawMessage(`{"token":`)), "invalid definition")
}
