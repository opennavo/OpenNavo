package testutil

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers/legacy"
)

// ValidateResponse validates the actual route and status; success models cannot substitute for business-error branches.
func ValidateResponse(t *testing.T, spec *openapi3.T, basePath string, request *http.Request, response *httptest.ResponseRecorder) {
	t.Helper()
	spec.Servers = openapi3.Servers{&openapi3.Server{URL: basePath}}
	router, err := legacy.NewRouter(spec)
	if err != nil {
		t.Fatal(err)
	}
	route, params, err := router.FindRoute(request)
	if err != nil {
		t.Fatal(err)
	}
	input := &openapi3filter.ResponseValidationInput{RequestValidationInput: &openapi3filter.RequestValidationInput{Request: request, PathParams: params, Route: route}, Status: response.Code, Header: response.Header(), Options: &openapi3filter.Options{IncludeResponseStatus: true}}
	input.SetBodyBytes(bytes.Clone(response.Body.Bytes()))
	if err := openapi3filter.ValidateResponse(context.Background(), input); err != nil {
		t.Fatalf("response violates contract: %v", err)
	}
}
