package admin

import (
	"bytes"
	"context"
	"image"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/opennavo/opennavo/server/gen/adminapi"
	"github.com/opennavo/opennavo/server/internal/domain"
	"github.com/opennavo/opennavo/server/internal/service/assets"
	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/stretchr/testify/require"
)

type assetURLTransport func(*http.Request) (*http.Response, error)

func (f assetURLTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestAssetURLAndFileDryRun(t *testing.T) {
	var picture bytes.Buffer
	require.NoError(t, png.Encode(&picture, image.NewRGBA(image.Rect(0, 0, 256, 256))))
	for _, tc := range []struct {
		name                        string
		file, url, duplicate, valid bool
	}{
		{name: "URL", url: true, valid: true}, {name: "file", file: true, valid: true},
		{name: "neither"}, {name: "both", file: true, url: true}, {name: "duplicate", url: true, duplicate: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var body bytes.Buffer
			writer := multipart.NewWriter(&body)
			require.NoError(t, writer.WriteField("kind", "icon"))
			if tc.file {
				p, err := writer.CreateFormFile("file", "icon.png")
				require.NoError(t, err)
				_, err = p.Write(picture.Bytes())
				require.NoError(t, err)
			}
			if tc.url {
				require.NoError(t, writer.WriteField("downloadUrl", "https://example.com/icon.png"))
			}
			if tc.duplicate {
				require.NoError(t, writer.WriteField("downloadUrl", "https://example.com/other.png"))
			}
			require.NoError(t, writer.Close())
			downloads := 0
			h := &Handler{Assets: &assets.Service{URLClient: &http.Client{Transport: assetURLTransport(func(r *http.Request) (*http.Response, error) {
				downloads++
				return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(picture.Bytes())), ContentLength: int64(picture.Len()), Request: r}, nil
			})}}}
			// Leave Store and Objects nil so any preview write fails immediately.
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Request = httptest.NewRequest(http.MethodPost, "/assets?dryRun=true", nil).WithContext(domain.WithOperation(context.Background(), &domain.Operation{DryRun: true, RequestID: "preview-only"}))
			id := int64(1)
			c.Set("adminActor", store.AuditActor{ID: &id})
			response, err := h.UploadAsset(c, adminapi.UploadAssetRequestObject{Body: multipart.NewReader(&body, writer.Boundary())})
			if !tc.valid {
				require.Error(t, err)
				require.Zero(t, downloads)
				return
			}
			require.NoError(t, err)
			recorder := httptest.NewRecorder()
			require.NoError(t, response.VisitUploadAssetResponse(recorder))
			require.Contains(t, recorder.Body.String(), `"dryRun":true`)
			require.Contains(t, recorder.Body.String(), `"requestId":"preview-only"`)
			if tc.url {
				require.Equal(t, 1, downloads)
			} else {
				require.Zero(t, downloads)
			}
		})
	}
}
