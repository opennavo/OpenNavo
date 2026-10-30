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
		for method, externalOperation := range externalItem.Operations() {
			internalOperation, ok := internalItem.Operations()[method]
			require.True(t, ok, "public operation %s %s is missing from the internal contract", method, path)
			t.Run(method+" "+path, func(t *testing.T) {
				operationPath := method + " " + path
				seen := map[[2]*openapi3.Schema]bool{}
				internalParameters := publicOperationParameters(t, internalItem.Parameters, internalOperation.Parameters)
				for key, parameter := range publicOperationParameters(t, externalItem.Parameters, externalOperation.Parameters) {
					internalParameter, ok := internalParameters[key]
					require.True(t, ok, "%s: parameter %s is missing from the internal contract", operationPath, key)
					parameterPath := operationPath + ".parameters." + key
					require.Equal(t, internalParameter.Name, parameter.Name, "%s: name", parameterPath)
					require.Equal(t, internalParameter.In, parameter.In, "%s: in", parameterPath)
					require.Equal(t, internalParameter.Required, parameter.Required, "%s: required", parameterPath)
					if parameter.Schema != nil || internalParameter.Schema != nil {
						requirePublicSchemaSubset(t, parameterPath+".schema", parameter.Schema, internalParameter.Schema, seen)
					}
					requirePublicContentSubset(t, parameterPath+".content", parameter.Content, internalParameter.Content, seen)
				}
				if externalOperation.RequestBody != nil {
					require.NotNil(t, internalOperation.RequestBody, "%s: requestBody", operationPath)
					require.NotNil(t, externalOperation.RequestBody.Value, "%s: resolved external requestBody", operationPath)
					require.NotNil(t, internalOperation.RequestBody.Value, "%s: resolved internal requestBody", operationPath)
					requirePublicContentSubset(t, operationPath+".requestBody", externalOperation.RequestBody.Value.Content, internalOperation.RequestBody.Value.Content, seen)
				}
				for status, response := range externalOperation.Responses.Map() {
					internalResponse := internalOperation.Responses.Value(status)
					// The public contract documents rate-limit responses covered by the internal default response.
					if internalResponse == nil {
						internalResponse = internalOperation.Responses.Default()
					}
					responsePath := operationPath + ".responses." + status
					require.NotNil(t, internalResponse, "%s is missing from the internal contract", responsePath)
					require.NotNil(t, response.Value, "%s: resolved external response", responsePath)
					require.NotNil(t, internalResponse.Value, "%s: resolved internal response", responsePath)
					requirePublicContentSubset(t, responsePath, response.Value.Content, internalResponse.Value.Content, seen)
				}
			})
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

func TestPublicSchemaSubsetAllowsOmittedRequiredAndEnumValues(t *testing.T) {
	internal := &openapi3.SchemaRef{Value: &openapi3.Schema{
		Required: []string{"public", "internal"},
		Enum:     []any{"stable", "internal"},
	}}
	for name, schema := range map[string]*openapi3.Schema{
		"narrower": {Required: []string{"public"}, Enum: []any{"stable"}},
		"omitted":  {},
	} {
		t.Run(name, func(t *testing.T) {
			requirePublicSchemaSubset(t, name, &openapi3.SchemaRef{Value: schema}, internal, map[[2]*openapi3.Schema]bool{})
		})
	}
}

func publicOperationParameters(t *testing.T, groups ...openapi3.Parameters) map[string]*openapi3.Parameter {
	t.Helper()
	parameters := map[string]*openapi3.Parameter{}
	// Operation parameters override path parameters with the same name and location.
	for _, group := range groups {
		for _, ref := range group {
			require.NotNil(t, ref)
			require.NotNil(t, ref.Value)
			parameters[ref.Value.In+":"+ref.Value.Name] = ref.Value
		}
	}
	return parameters
}

func requirePublicContentSubset(t *testing.T, path string, external, internal openapi3.Content, seen map[[2]*openapi3.Schema]bool) {
	t.Helper()
	for mediaType, content := range external {
		internalContent, ok := internal[mediaType]
		require.True(t, ok, "%s: media type %s is missing from the internal contract", path, mediaType)
		require.NotNil(t, content, "%s: external content", path)
		require.NotNil(t, internalContent, "%s: internal content", path)
		if content.Schema != nil || internalContent.Schema != nil {
			requirePublicSchemaSubset(t, path+".content."+mediaType, content.Schema, internalContent.Schema, seen)
		}
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
	require.Equal(t, b.Nullable, a.Nullable, "%s: nullable", path)
	require.Equal(t, b.Format, a.Format, "%s: format", path)
	require.Equal(t, b.MinLength, a.MinLength, "%s: minLength", path)
	require.Equal(t, b.MaxLength, a.MaxLength, "%s: maxLength", path)
	require.Equal(t, b.Pattern, a.Pattern, "%s: pattern", path)
	require.Equal(t, b.Min, a.Min, "%s: minimum", path)
	require.Equal(t, b.Max, a.Max, "%s: maximum", path)
	require.Equal(t, b.ExclusiveMin, a.ExclusiveMin, "%s: exclusiveMinimum", path)
	require.Equal(t, b.ExclusiveMax, a.ExclusiveMax, "%s: exclusiveMaximum", path)
	require.Equal(t, b.AdditionalProperties.Has, a.AdditionalProperties.Has, "%s: additionalProperties", path)
	require.Equal(t, b.AdditionalProperties.Schema != nil, a.AdditionalProperties.Schema != nil, "%s: additionalProperties schema", path)
	for _, required := range a.Required {
		require.Contains(t, b.Required, required, "%s: required", path)
	}
	for _, value := range a.Enum {
		require.Contains(t, b.Enum, value, "%s: enum", path)
	}
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
