//go:build integration

package httpserver_test

import (
	"bytes"
	"context"
	"image"
	"image/png"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http/httptest"
	"testing"

	"github.com/opennavo/opennavo/server/gen/adminapi"
	"github.com/opennavo/opennavo/server/internal/config"
	httpserver "github.com/opennavo/opennavo/server/internal/http"
	"github.com/opennavo/opennavo/server/internal/http/admin"
	"github.com/opennavo/opennavo/server/internal/service/assets"
	"github.com/opennavo/opennavo/server/internal/testutil"
	"github.com/stretchr/testify/require"
)

type memoryObjects struct{}

func (memoryObjects) Put(context.Context, string, []byte, string) error { return nil }
func (memoryObjects) URL(k string) string                               { return "https://cdn.example.test/" + k }
func TestUploadAssetContractAndAuthorization(t *testing.T) {
	st := testutil.NewStore(t)
	server, err := httpserver.New(config.Config{}, slog.New(slog.NewTextHandler(io.Discard, nil)), st, httpserver.Dependencies{Admin: &admin.Handler{Assets: &assets.Service{Store: st, Objects: memoryObjects{}}, CIToken: "local-test-ci"}})
	require.NoError(t, err)
	spec, err := adminapi.GetSpec()
	require.NoError(t, err)
	var pngData bytes.Buffer
	require.NoError(t, png.Encode(&pngData, image.NewNRGBA(image.Rect(0, 0, 256, 256))))
	for _, tc := range []struct {
		token string
		data  []byte
		code  string
	}{{"", pngData.Bytes(), "8888"}, {"local-test-ci", pngData.Bytes(), "0000"}, {"local-test-ci", []byte("invalid"), "1007"}} {
		var body bytes.Buffer
		w := multipart.NewWriter(&body)
		require.NoError(t, w.WriteField("kind", "icon"))
		part, err := w.CreateFormFile("file", "sample.png")
		require.NoError(t, err)
		_, err = part.Write(tc.data)
		require.NoError(t, err)
		require.NoError(t, w.Close())
		request := httptest.NewRequest("POST", "/admin-api/assets", &body)
		request.Header.Set("Content-Type", w.FormDataContentType())
		request.Header.Set("Authorization", "Bearer "+tc.token)
		reply := httptest.NewRecorder()
		server.Engine.ServeHTTP(reply, request)
		testutil.ValidateResponse(t, spec, "/admin-api", request, reply)
		require.Equal(t, 200, reply.Code)
		require.Contains(t, reply.Body.String(), `"code":"`+tc.code+`"`)
	}
}
