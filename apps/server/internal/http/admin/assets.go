package admin

import (
	"context"
	"crypto/subtle"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/opennavo/opennavo/server/gen/adminapi"
	"github.com/opennavo/opennavo/server/internal/domain"
	"github.com/opennavo/opennavo/server/internal/store"
)

func requestContext(ctx context.Context) context.Context {
	if c, ok := ctx.(*gin.Context); ok {
		return c.Request.Context()
	}
	return ctx
}
func (h *Handler) assetActor(ctx context.Context) (store.AuditActor, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return store.AuditActor{}, &domain.AppError{Code: domain.CodeUnauthenticated, HTTPStatus: 401}
	}
	if value, ok := c.Get("adminActor"); ok {
		if actor, ok := value.(store.AuditActor); ok && actor.ID != nil {
			return actor, nil
		}
	}
	token := strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer ")
	if h.CIToken == "" || subtle.ConstantTimeCompare([]byte(token), []byte(h.CIToken)) != 1 {
		return store.AuditActor{}, &domain.AppError{Code: domain.CodeUnauthenticated, HTTPStatus: 401}
	}
	return store.AuditActor{IP: c.ClientIP(), UserAgent: c.GetHeader("User-Agent")}, nil
}
func (h *Handler) UploadAsset(ctx context.Context, request adminapi.UploadAssetRequestObject) (adminapi.UploadAssetResponseObject, error) {
	if h.Assets == nil {
		return nil, domain.Internal(nil)
	}
	actor, err := h.assetActor(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, domain.Validation()
	}
	kind := ""
	downloadURL := ""
	seen := map[string]bool{}
	var data []byte
	var source *string
	parts := 0
	for {
		part, err := request.Body.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, domain.Validation()
		}
		if seen[part.FormName()] {
			_ = part.Close()
			return nil, domain.Validation()
		}
		seen[part.FormName()] = true
		parts++
		if parts > 10 {
			return nil, domain.Validation()
		}
		limit := int64(2048)
		if part.FormName() == "file" {
			limit = 5 * 1024 * 1024
		}
		value, err := io.ReadAll(io.LimitReader(part, limit+1))
		_ = part.Close()
		if err != nil {
			return nil, domain.Validation()
		}
		if int64(len(value)) > limit {
			return nil, &domain.AppError{Code: domain.CodeInvalidUpload, HTTPStatus: http.StatusBadRequest}
		}
		switch part.FormName() {
		case "file":
			if data != nil {
				return nil, domain.Validation()
			}
			data = value
		case "kind":
			kind = string(value)
		case "downloadUrl":
			downloadURL = string(value)
		case "sourceUrl":
			text := string(value)
			source = &text
		}
	}
	if (data == nil) == (downloadURL == "") {
		return nil, domain.Validation()
	}
	if downloadURL != "" {
		data, err = h.Assets.DownloadURL(requestContext(ctx), downloadURL)
		if err != nil {
			return nil, err
		}
		if source == nil {
			source = &downloadURL
		}
	}
	if op := domain.CurrentOperation(requestContext(ctx)); op != nil && op.DryRun {
		after, err := h.Assets.Preview(kind, data)
		if err != nil {
			return nil, err
		}
		return response[adminapi.UploadAsset200JSONResponse](map[string]any{"dryRun": true, "requestId": op.RequestID, "changes": []any{map[string]any{"object": map[string]any{"entity": "asset", "objectKey": "new"}, "action": "create", "before": nil, "after": after}}, "affectedUrls": []string{}}, nil)
	}
	if op := domain.CurrentOperation(requestContext(ctx)); op != nil {
		op.Name = "uploadAsset"
	}
	asset, err := h.Assets.Upload(requestContext(ctx), kind, data, source, actor)
	if err != nil {
		return nil, err
	}
	var out adminapi.AssetResponseResult
	if err := out.FromAssetResponse(adminapi.AssetResponse{Code: domain.CodeOK, Msg: "ok", Data: &asset}); err != nil {
		return nil, err
	}
	return adminapi.UploadAsset200JSONResponse{Body: out}, nil
}
