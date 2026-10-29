package api

import _ "embed"

// PublicExternalOpenAPI is the stable, read-only contract served from the public API host.
// Keep this separate from public.openapi.yaml: the latter is the internal server contract and
// also contains client reporting and desktop routes that must never be advertised externally.
//
//go:embed public-external.openapi.yaml
var PublicExternalOpenAPI []byte
