package management

import (
	"testing"

	"github.com/opennavo/opennavo/server/internal/domain"
	"github.com/stretchr/testify/require"
)

func TestManualLinkVersion(t *testing.T) {
	stored := "9.9"
	repo := "owner/app"
	feed := "https://example.com/appcast.xml"

	input := domain.LinkInput{Version: &stored}
	require.NoError(t, manualVersion(map[string]any{"name": "App"}, &input))
	require.Nil(t, input.Version, "a version merged from the stored row is never written")

	input = domain.LinkInput{}
	require.NoError(t, manualVersion(map[string]any{"version": " 1.0.7 "}, &input))
	require.Equal(t, "1.0.7", *input.Version)

	for _, bad := range []any{"", "beta", "v 1", "-1.0", "1.0/2", nil, 107} {
		input = domain.LinkInput{}
		require.Error(t, manualVersion(map[string]any{"version": bad}, &input), "%v", bad)
	}
	for _, sourced := range []domain.LinkInput{{GithubRepo: &repo}, {SparkleFeed: &feed}} {
		err := manualVersion(map[string]any{"version": "1.0.7"}, &sourced)
		require.ErrorContains(t, err, "version_managed_by_source")
	}
}
