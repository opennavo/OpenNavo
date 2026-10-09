package admin

import (
	"context"

	"github.com/opennavo/opennavo/server/gen/adminapi"
	"github.com/opennavo/opennavo/server/internal/domain"
)

func (h *Handler) GetGitHubSettings(ctx context.Context, request adminapi.GetGitHubSettingsRequestObject) (adminapi.GetGitHubSettingsResponseObject, error) {
	if h.Management == nil {
		return nil, domain.Internal(nil)
	}
	data, err := h.manage(ctx, "GetGitHubSettings", request)
	return response[adminapi.GetGitHubSettings200JSONResponse](data, err)
}

func (h *Handler) UpdateGitHubSettings(ctx context.Context, request adminapi.UpdateGitHubSettingsRequestObject) (adminapi.UpdateGitHubSettingsResponseObject, error) {
	if h.Management == nil {
		return nil, domain.Internal(nil)
	}
	data, err := h.manage(ctx, "UpdateGitHubSettings", request)
	return response[adminapi.UpdateGitHubSettings200JSONResponse](data, err)
}
