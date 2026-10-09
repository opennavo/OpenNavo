package snapshot

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/opennavo/opennavo/server/gen/publicapi"
	"github.com/opennavo/opennavo/server/internal/domain"
	"github.com/opennavo/opennavo/server/internal/http/respond"
	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/opennavo/opennavo/server/seeds"
	"github.com/opennavo/opennavo/server/testdata"
	"github.com/stretchr/testify/require"
)

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := testdata.Desktop.ReadFile("desktop/" + name)
	require.NoError(t, err)
	return data
}

func TestCommittedSnapshotUsesCurrentSerializationAndSeedData(t *testing.T) {
	compressed := readFixture(t, "catalog.json.gz")
	reader, err := gzip.NewReader(bytes.NewReader(compressed))
	require.NoError(t, err)
	raw, err := io.ReadAll(reader)
	require.NoError(t, err)
	require.NoError(t, reader.Close())
	var document Document
	require.NoError(t, json.Unmarshal(raw, &document))
	currentRaw, currentCompressed, err := encodeDocument(document)
	require.NoError(t, err)
	require.Equal(t, raw, currentRaw, "snapshot field serialization changed; regenerate fixtures deliberately")
	require.Equal(t, compressed, currentCompressed, "gzip serialization changed")
	require.Equal(t, 1, document.FormatVersion)
	require.Len(t, document.Categories, 20)
	seed, err := seeds.LoadE2E()
	require.NoError(t, err)
	require.Len(t, document.Items, 40)
	items := map[string]publicapi.CatalogItem{}
	for _, item := range document.Items {
		items[string(item.Kind)+"/"+item.Token] = item
	}
	for _, packageSeed := range seed.Packages {
		item, ok := items[packageSeed.Kind+"/"+packageSeed.Token]
		if packageSeed.Kind == "formula" {
			require.False(t, ok)
			continue
		}
		require.True(t, ok)
		require.Equal(t, packageSeed.Name, item.Name)
		require.Equal(t, packageSeed.Version, item.Version)
		require.Equal(t, packageSeed.DisplayName, *item.DisplayName.ZhCN)
		require.Equal(t, packageSeed.Summary, *item.Summary.ZhCN)
		require.Contains(t, item.Categories, packageSeed.Category)
		require.NotNil(t, item.DownloadSize)
		require.Positive(t, *item.DownloadSize)
		require.Greater(t, *item.Installs90d, item.Installs30d)
		require.Greater(t, *item.Installs365d, *item.Installs90d)
		require.Nil(t, item.OnRequest)
	}
	var latest publicapi.CatalogSnapshotInfo
	require.NoError(t, json.Unmarshal(readFixture(t, "latest.json"), &latest))
	hash := sha256.Sum256(compressed)
	require.Equal(t, hex.EncodeToString(hash[:]), latest.Sha256)
	require.Equal(t, int64(len(compressed)), latest.Bytes)
	require.Equal(t, len(document.Items), latest.ItemCount)
	require.Equal(t, document.Cursor, latest.Cursor)
	encoded, err := json.Marshal(info(store.SnapshotRecord{FormatVersion: document.FormatVersion, Seq: document.Cursor, ItemCount: len(document.Items), URL: latest.Url, SHA256: latest.Sha256, Bytes: latest.Bytes, CreatedAt: document.GeneratedAt}))
	require.NoError(t, err)
	require.Equal(t, readFixture(t, "latest.json"), encoded, "metadata serialization changed")
}

func TestCommittedDeltaAndClientConfigurationUseCurrentModels(t *testing.T) {
	for _, name := range []string{"changes-page.json", "changes-final.json", "changes-empty.json"} {
		var response publicapi.CatalogChangesResponse
		data := readFixture(t, name)
		require.NoError(t, json.Unmarshal(data, &response))
		encoded, err := json.Marshal(response)
		require.NoError(t, err)
		require.Equal(t, data, encoded, "delta response serialization changed")
		require.Equal(t, "0000", response.Code)
		switch name {
		case "changes-page.json":
			require.Len(t, response.Data.Changes, 3)
			require.True(t, response.Data.HasMore)
			require.Equal(t, int64(63), response.Data.NextCursor)
			require.Equal(t, publicapi.CatalogChangeOp("delete"), response.Data.Changes[1].Op)
			require.Nil(t, response.Data.Changes[1].Item)
			require.Equal(t, "1.140.1", response.Data.Changes[0].Item.Version)
		case "changes-final.json":
			require.Len(t, response.Data.Changes, 1)
			require.False(t, response.Data.HasMore)
			require.Equal(t, int64(64), response.Data.NextCursor)
		default:
			require.Empty(t, response.Data.Changes)
			require.False(t, response.Data.HasMore)
			require.Equal(t, int64(64), response.Data.NextCursor)
		}
	}
	var response publicapi.ClientConfigResponse
	data := readFixture(t, "client-config.json")
	require.NoError(t, json.Unmarshal(data, &response))
	encoded, err := json.Marshal(response)
	require.NoError(t, err)
	require.Equal(t, data, encoded, "client configuration serialization changed")
	require.NotEmpty(t, response.Data.Mirrors)
}

func TestCommittedExpiredCursorUsesCurrentErrorResponse(t *testing.T) {
	reply := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(reply)
	ctx.Request = httptest.NewRequest("GET", "/api/v1/catalog/changes?since=0&locale=zh-CN", nil)
	respond.Error(ctx, &domain.AppError{Code: domain.CodeCursorExpired, HTTPStatus: 410}, false)
	require.Equal(t, 410, reply.Code)
	require.JSONEq(t, string(readFixture(t, "changes-expired.json")), reply.Body.String())
	var response publicapi.CatalogSnapshotResponse
	data := readFixture(t, "snapshot.json")
	require.NoError(t, json.Unmarshal(data, &response))
	metadata, err := json.Marshal(response.Data)
	require.NoError(t, err)
	require.Equal(t, readFixture(t, "latest.json"), metadata)
}
