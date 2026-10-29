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
		"/packages/lookup":                      {},
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
		requests := int64(300)
		if path == "/packages/lookup" {
			require.Nil(t, item.Get, path)
			op = item.Post
			requests = 30
			require.NotNil(t, op, path)
			require.NotNil(t, op.RequestBody, path)
			require.Contains(t, op.RequestBody.Value.Content, "application/json", path)
			require.Contains(t, op.Description, "POST only", path)
			require.Contains(t, op.Description, "JSON request body", path)
			require.Contains(t, op.Description, "GET ?tokens=", path)
		} else {
			require.NotNil(t, op, path)
		}
		limit, ok := op.Extensions["x-rate-limit"].(map[string]interface{})
		require.True(t, ok, path)
		require.Equal(t, "GCRA", limit["algorithm"], path)
		require.Equal(t, "per-ip", limit["scope"], path)
		if path == "/search" {
			requests = 60
		}
		require.EqualValues(t, requests, limit["requests"], path)
	}

	for _, forbidden := range []string{
		"/usage/activity",
		"/search/clicks",
		"/feedback",
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
