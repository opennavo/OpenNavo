//go:build integration

package urlnotify

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/opennavo/opennavo/server/internal/config"
	"github.com/opennavo/opennavo/server/internal/testutil"
	"github.com/stretchr/testify/require"
)

func TestBingReportBackfillSubmitsMissingURLsOnce(t *testing.T) {
	st := testutil.NewSEOStore(t)
	ctx := context.Background()
	cfg := config.Config{JWTSecret: strings.Repeat("a", 32), WebBaseURL: "https://site.example.test"}
	key, err := cfg.EncryptSEOSecret("indexnow", "fixture-indexnow-key")
	require.NoError(t, err)
	require.NoError(t, st.DB.Exec(`UPDATE seo_settings SET indexnow_key_ciphertext=?, settings=settings||'{"indexNow":{"enabled":true}}'::jsonb WHERE id=true`, key).Error)

	var (
		mu        sync.Mutex
		batches   [][]string
		decodeErr error
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			URLList []string `json:"urlList"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			mu.Lock()
			decodeErr = err
			mu.Unlock()
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		mu.Lock()
		batches = append(batches, payload.URLList)
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	n := &Notifier{Store: st, Config: cfg, IndexNowEndpoint: server.URL, Sleep: func(time.Duration) {}}
	require.NoError(t, n.AnnounceBingReportURLs(ctx))
	mu.Lock()
	seen := append([][]string(nil), batches...)
	errSeen := decodeErr
	mu.Unlock()
	require.NoError(t, errSeen)
	require.NotEmpty(t, seen)
	submitted := 0
	for _, batch := range seen {
		submitted += len(batch)
	}
	require.Equal(t, len(bingReportURLs), submitted)
	require.Equal(t, "https://site.example.test"+bingReportURLs[0].Path, seen[0][0])

	// A second tick must not submit again once the marker row exists.
	before := len(seen)
	require.NoError(t, n.AnnounceBingReportURLs(ctx))
	mu.Lock()
	seen = append([][]string(nil), batches...)
	mu.Unlock()
	require.Len(t, seen, before)
	total := 0
	for _, batch := range seen {
		total += len(batch)
	}
	require.Equal(t, len(bingReportURLs), total)
	var completed int64
	require.NoError(t, st.DB.Table("indexnow_backfill").Count(&completed).Error)
	require.EqualValues(t, 1, completed)
}
