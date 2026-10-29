package api_test

import (
	"context"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/stretchr/testify/require"
)

func TestPublicExternalContractIsReadOnlyAndExcludesInternalRoutes(t *testing.T) {
	loader := openapi3.NewLoader()
	loader.IsExternalRefsAllowed = false
	spec, err := loader.LoadFromFile("public-external.openapi.yaml")
	require.NoError(t, err)
	require.NoError(t, spec.Validate(context.Background()))

	expected := map[string]struct{}{
		"/categories":                           {},
		"/search":                               {},
		"/packages/{kind}/{token}":              {},
		"/packages/{kind}/{token}/releases":     {},
		"/packages/{kind}/{token}/dependencies": {},
		"/packages/{kind}/{token}/related":      {},
		"/rankings":                             {},
		"/collections":                          {},
		"/collections/{slug}":                   {},
		"/collections/{slug}/brewfile":          {},
		"/articles":                             {},
		"/articles/{slug}":                      {},
	}
	require.Equal(t, expected, func() map[string]struct{} {
		actual := map[string]struct{}{}
		for path := range spec.Paths.Map() {
			actual[path] = struct{}{}
		}
		return actual
	}())

	for path, item := range spec.Paths.Map() {
		require.Len(t, item.Operations(), 1, path)
		op := item.Get
		require.NotNil(t, op, path)
		limit, ok := op.Extensions["x-rate-limit"].(map[string]interface{})
		require.True(t, ok, path)
		require.Equal(t, "GCRA", limit["algorithm"], path)
		require.Equal(t, "per-ip", limit["scope"], path)
		if path == "/search" {
			require.EqualValues(t, 60, limit["requests"], path)
		} else {
			require.EqualValues(t, 300, limit["requests"], path)
		}
	}

	for _, forbidden := range []string{
		"/usage/activity",
		"/search/clicks",
		"/feedback",
		"/packages/lookup",
		"/catalog/update-feeds",
		"/catalog/snapshot",
		"/catalog/changes",
		"/config/client",
		"/desktop/releases/latest",
		"/site/settings",
		"/site/indexnow-keys/{key}",
		"/sitemap/packages",
	} {
		_, present := spec.Paths.Map()[forbidden]
		require.False(t, present, forbidden)
	}
}
