package testdata

import "embed"

// Desktop is used only by Go fixture tests; Rust reads files from the same directory directly.
//
//go:embed desktop/*.json desktop/*.gz
var Desktop embed.FS
