package search

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/opennavo/opennavo/server/internal/domain"
	"github.com/stretchr/testify/require"
)

type testRepo struct {
	SynonymErr, SearchErr, IDErr, SuggestErr error
	Synonyms                                 []string
	Terms                                    []string
	Query                                    domain.SearchInput
	mutex                                    sync.Mutex
	events                                   []string
	suggestions                              int
}

func (r *testRepo) SearchSynonyms(context.Context, string) ([]string, error) {
	return r.Synonyms, r.SynonymErr
}
func (r *testRepo) Search(_ context.Context, input domain.SearchInput, terms []string, _ float64, _ float64) ([]domain.SearchMatch, int64, error) {
	r.Query, r.Terms = input, terms
	return []domain.SearchMatch{{ID: 7, Score: 3}}, 1, r.SearchErr
}
func (r *testRepo) SearchPenalty(_ context.Context, _ string, fallback float64) float64 {
	return fallback
}
func (r *testRepo) Suggest(context.Context, string, string, int) ([]domain.Suggestion, error) {
	r.suggestions++
	return []domain.Suggestion{{Type: "package", Name: "One"}, {Type: "package", Name: "Two"}}, r.SuggestErr
}
func (r *testRepo) ReserveQueryID(context.Context) (int64, error) { return 3, r.IDErr }
func (r *testRepo) SaveSearchQuery(ctx context.Context, log domain.SearchQueryLog) error {
	r.mutex.Lock()
	defer r.mutex.Unlock()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	r.events = append(r.events, "query")
	return nil
}
func (r *testRepo) SaveSearchClick(context.Context, int64, string, string, int) error {
	r.mutex.Lock()
	defer r.mutex.Unlock()
	r.events = append(r.events, "click")
	return nil
}

type testCache struct {
	value []byte
	key   string
	ttl   time.Duration
	fail  bool
}

func (c *testCache) Load(context.Context, string) ([]byte, error) {
	if len(c.value) == 0 || c.fail {
		return nil, ErrCacheMiss
	}
	return c.value, nil
}
func (c *testCache) Save(_ context.Context, key string, value []byte, ttl time.Duration) error {
	c.key, c.value, c.ttl = key, value, ttl
	return nil
}
func validInput() domain.SearchInput {
	return domain.SearchInput{Query: "vscode", Current: 1, Size: 20, Locale: "zh-CN", Platform: "web"}
}
func newService(t *testing.T, repo *testRepo, cache Cache) *Service {
	t.Helper()
	service := New(context.Background(), repo, cache, slog.New(slog.NewTextHandler(io.Discard, nil)))
	t.Cleanup(service.Close)
	return service
}

func TestSearchExpansionNormalizationAndOrderedDetachedTelemetry(t *testing.T) {
	repo := &testRepo{Synonyms: []string{"vs code", "ＶＳＣＯＤＥ", "vs code", ""}}
	service := newService(t, repo, nil)
	input := validInput()
	input.Query = " ＶＳＣＯＤＥ "
	ctx, cancel := context.WithCancel(context.Background())
	result, err := service.Search(ctx, input)
	require.NoError(t, err)
	cancel()
	require.Equal(t, "3", result.QueryID)
	require.Equal(t, []string{"vs code"}, result.ExpandedTerms)
	require.Equal(t, []string{"vscode", "vs code"}, repo.Terms)
	require.NoError(t, service.Click(context.Background(), result.QueryID, "cask", "visual-studio-code", 1))
	service.Close()
	repo.mutex.Lock()
	require.Equal(t, []string{"query", "click"}, repo.events)
	repo.mutex.Unlock()
	service.Close()
	service.enqueue(func(context.Context) error { t.Fatal("closed service processed telemetry"); return nil })
}
func TestSearchValidationAndRepositoryErrors(t *testing.T) {
	for _, field := range []string{"query", "kind", "current", "size", "locale", "platform"} {
		t.Run(field, func(t *testing.T) {
			input := validInput()
			switch field {
			case "query":
				input.Query = "!!!"
			case "kind":
				input.Kind = "bad"
			case "current":
				input.Current = 0
			case "size":
				input.Size = 101
			case "locale":
				input.Locale = "bad"
			case "platform":
				input.Platform = "bad"
			}
			_, err := newService(t, &testRepo{}, nil).Search(context.Background(), input)
			require.Error(t, err)
		})
	}
	for _, repo := range []*testRepo{{SynonymErr: errors.New("failed")}, {SearchErr: errors.New("failed")}, {IDErr: errors.New("failed")}} {
		_, err := newService(t, repo, nil).Search(context.Background(), validInput())
		require.Error(t, err)
	}
	service := newService(t, &testRepo{}, nil)
	for _, example := range []struct {
		ID, Kind, Token string
		Position        int
	}{{"bad", "cask", "a", 1}, {"0", "cask", "a", 1}, {"1", "bad", "a", 1}, {"1", "cask", "", 1}, {"1", "cask", "a", 0}} {
		require.Error(t, service.Click(context.Background(), example.ID, example.Kind, example.Token, example.Position))
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	require.ErrorIs(t, service.Click(ctx, "1", "cask", "a", 1), context.Canceled)
}
func TestSuggestionsCacheMaximumAndFailures(t *testing.T) {
	repo := &testRepo{}
	cache := &testCache{}
	service := newService(t, repo, cache)
	items, err := service.Suggest(context.Background(), " ＷＥＩＸＩＮ ", "zh-CN", 1)
	require.NoError(t, err)
	require.Len(t, items, 1)
	require.Equal(t, "c:sug:c2:zh-CN:weixin", cache.key)
	require.Equal(t, 10*time.Minute, cache.ttl)
	items, err = service.Suggest(context.Background(), "weixin", "zh-CN", 10)
	require.NoError(t, err)
	require.Len(t, items, 2)
	require.Equal(t, 1, repo.suggestions)
	cache.value = []byte("invalid")
	_, err = service.Suggest(context.Background(), "weixin", "zh-CN", 2)
	require.NoError(t, err)
	require.Equal(t, 2, repo.suggestions)
	repo.SuggestErr = errors.New("failed")
	cache.fail = true
	_, err = service.Suggest(context.Background(), "weixin", "zh-CN", 2)
	require.Error(t, err)
	for _, example := range []struct {
		Query, Locale string
		Limit         int
	}{{"", "zh-CN", 8}, {"a", "bad", 8}, {"a", "zh-CN", 11}} {
		_, err := service.Suggest(context.Background(), example.Query, example.Locale, example.Limit)
		require.Error(t, err)
	}
}
