package api_test

import (
	"context"
	"fmt"
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
		requests := int64(300)
		require.NotNil(t, op, path)
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
		"/packages/lookup",
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

func TestPublicExternalContractIsSubsetOfInternalContract(t *testing.T) {
	loader := openapi3.NewLoader()
	loader.IsExternalRefsAllowed = false
	external, err := loader.LoadFromFile("public-external.openapi.yaml")
	require.NoError(t, err)
	internal, err := loader.LoadFromFile("public.openapi.yaml")
	require.NoError(t, err)

	for path, externalItem := range external.Paths.Map() {
		internalItem, ok := internal.Paths.Map()[path]
		require.True(t, ok, "public path %s is missing from the internal contract", path)
		for method := range externalItem.Operations() {
			_, ok := internalItem.Operations()[method]
			require.True(t, ok, "public operation %s %s is missing from the internal contract", method, path)
		}
	}
	for name, externalSchema := range external.Components.Schemas {
		t.Run(name, func(t *testing.T) {
			internalSchema, ok := internal.Components.Schemas[name]
			require.True(t, ok, "public schema %s is missing from the internal contract", name)
			requirePublicSchemaSubset(t, name, externalSchema, internalSchema, map[[2]*openapi3.Schema]bool{})
		})
	}
}

func requirePublicSchemaSubset(t *testing.T, path string, external, internal *openapi3.SchemaRef, seen map[[2]*openapi3.Schema]bool) {
	t.Helper()
	require.NotNil(t, external, "%s: external schema", path)
	require.NotNil(t, internal, "%s: internal schema", path)
	require.NotNil(t, external.Value, "%s: resolved external schema", path)
	require.NotNil(t, internal.Value, "%s: resolved internal schema", path)
	a, b := external.Value, internal.Value
	pair := [2]*openapi3.Schema{a, b}
	if seen[pair] {
		return
	}
	seen[pair] = true
	require.Equal(t, b.Type, a.Type, "%s: type", path)
	require.ElementsMatch(t, b.Required, a.Required, "%s: required", path)
	require.ElementsMatch(t, b.Enum, a.Enum, "%s: enum", path)
	for name, property := range a.Properties {
		internalProperty, ok := b.Properties[name]
		require.True(t, ok, "%s.properties.%s is missing from the internal contract", path, name)
		requirePublicSchemaSubset(t, path+".properties."+name, property, internalProperty, seen)
	}
	for _, child := range []struct {
		name               string
		external, internal *openapi3.SchemaRef
	}{
		{"items", a.Items, b.Items},
		{"additionalProperties", a.AdditionalProperties.Schema, b.AdditionalProperties.Schema},
		{"not", a.Not, b.Not},
	} {
		if child.external != nil {
			requirePublicSchemaSubset(t, path+"."+child.name, child.external, child.internal, seen)
		}
	}
	for _, group := range []struct {
		name               string
		external, internal openapi3.SchemaRefs
	}{
		{"allOf", a.AllOf, b.AllOf},
		{"anyOf", a.AnyOf, b.AnyOf},
		{"oneOf", a.OneOf, b.OneOf},
	} {
		require.Len(t, group.internal, len(group.external), "%s.%s", path, group.name)
		for index, schema := range group.external {
			requirePublicSchemaSubset(t, fmt.Sprintf("%s.%s[%d]", path, group.name, index), schema, group.internal[index], seen)
		}
	}
}
