package admin

import (
	"context"

	"github.com/opennavo/opennavo/server/gen/adminapi"
	"github.com/opennavo/opennavo/server/internal/domain"
)

func (h *Handler) GetTranslationSettings(ctx context.Context, request adminapi.GetTranslationSettingsRequestObject) (adminapi.GetTranslationSettingsResponseObject, error) {
	if h.Management == nil {
		return nil, domain.Internal(nil)
	}
	data, err := h.manage(ctx, "GetTranslationSettings", request)
	return response[adminapi.GetTranslationSettings200JSONResponse](data, err)
}
func (h *Handler) UpdateTranslationSettings(ctx context.Context, request adminapi.UpdateTranslationSettingsRequestObject) (adminapi.UpdateTranslationSettingsResponseObject, error) {
	if h.Management == nil {
		return nil, domain.Internal(nil)
	}
	data, err := h.manage(ctx, "UpdateTranslationSettings", request)
	return response[adminapi.UpdateTranslationSettings200JSONResponse](data, err)
}

func (h *Handler) ListTranslationModels(ctx context.Context, request adminapi.ListTranslationModelsRequestObject) (adminapi.ListTranslationModelsResponseObject, error) {
	if h.Management == nil {
		return nil, domain.Internal(nil)
	}
	data, err := h.manage(ctx, "ListTranslationModels", request)
	return response[adminapi.ListTranslationModels200JSONResponse](data, err)
}
