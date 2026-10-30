package api_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"strconv"
	"strings"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/stretchr/testify/require"
)

// handlerSizeDefaults reads the public handler source and returns, per operationId, the page size
// it falls back to when the client omits ?size=, from either `fallback(request.Params.Size, N)` or
// `size := N` followed by an override from request.Params.Size.
func handlerSizeDefaults(t *testing.T) map[string]int {
	t.Helper()
	file, err := parser.ParseFile(token.NewFileSet(), "../internal/http/public/handler.go", nil, 0)
	require.NoError(t, err)
	isParamsSize := func(expr ast.Expr) bool {
		sel, ok := expr.(*ast.SelectorExpr)
		if !ok || sel.Sel.Name != "Size" {
			return false
		}
		params, ok := sel.X.(*ast.SelectorExpr)
		return ok && params.Sel.Name == "Params"
	}
	defaults := map[string]int{}
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Recv == nil || fn.Body == nil {
			continue
		}
		operation := strings.ToLower(fn.Name.Name[:1]) + fn.Name.Name[1:]
		literal := map[string]int{}
		ast.Inspect(fn.Body, func(node ast.Node) bool {
			switch n := node.(type) {
			case *ast.CallExpr:
				if ident, ok := n.Fun.(*ast.Ident); ok && ident.Name == "fallback" && len(n.Args) == 2 && isParamsSize(n.Args[0]) {
					if lit, ok := n.Args[1].(*ast.BasicLit); ok {
						value, _ := strconv.Atoi(lit.Value)
						defaults[operation] = value
					}
				}
			case *ast.AssignStmt:
				for i, lhs := range n.Lhs {
					ident, ok := lhs.(*ast.Ident)
					if !ok || i >= len(n.Rhs) {
						continue
					}
					if lit, ok := n.Rhs[i].(*ast.BasicLit); ok && lit.Kind == token.INT {
						value, _ := strconv.Atoi(lit.Value)
						literal[ident.Name] = value
					}
					if star, ok := n.Rhs[i].(*ast.StarExpr); ok && isParamsSize(star.X) {
						if value, ok := literal[ident.Name]; ok {
							defaults[operation] = value
						}
					}
				}
			}
			return true
		})
	}
	return defaults
}

func specSizeDefaults(t *testing.T, path string) map[string]int {
	t.Helper()
	loader := openapi3.NewLoader()
	spec, err := loader.LoadFromFile(path)
	require.NoError(t, err)
	defaults := map[string]int{}
	for _, item := range spec.Paths.Map() {
		for _, op := range item.Operations() {
			for _, ref := range op.Parameters {
				p := ref.Value
				if p == nil || p.In != "query" || p.Name != "size" || p.Schema == nil || p.Schema.Value == nil {
					continue
				}
				if def, ok := p.Schema.Value.Default.(float64); ok {
					defaults[op.OperationID] = int(def)
				}
			}
		}
	}
	return defaults
}

// The documented ?size= default must be what the handler really uses when the client omits it.
func TestPublicSpecSizeDefaultsMatchHandlerFallbacks(t *testing.T) {
	handler := handlerSizeDefaults(t)
	// Guard the parser itself on the two operations whose fallback differs from the shared 24.
	require.Equal(t, 20, handler["listPackageReleases"])
	require.Equal(t, 20, handler["listCollections"])
	for _, path := range []string{"public.openapi.yaml", "public-external.openapi.yaml"} {
		spec := specSizeDefaults(t, path)
		require.NotEmpty(t, spec, path)
		for operation, documented := range spec {
			actual, ok := handler[operation]
			if !ok {
				continue // non-literal fallback (e.g. a named constant); not comparable here
			}
			require.Equal(t, actual, documented, "%s: %s documents size default %d, handler falls back to %d",
				path, operation, documented, actual)
		}
	}
}
