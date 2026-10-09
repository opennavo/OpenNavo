package admin

import (
	"context"
	"encoding/json"

	"github.com/gin-gonic/gin"
	"github.com/opennavo/opennavo/server/gen/adminapi"
	"github.com/opennavo/opennavo/server/internal/domain"
	"github.com/opennavo/opennavo/server/internal/http/respond"
	"github.com/opennavo/opennavo/server/internal/service/auth"
	"github.com/opennavo/opennavo/server/internal/store"
)

func response[T any](data any, err error) (T, error) {
	var out T
	if err != nil {
		return out, err
	}
	if data == nil {
		data = struct{}{}
	}
	encoded, err := json.Marshal(respond.Envelope{Code: domain.CodeOK, Msg: "ok", Data: data})
	if err != nil {
		return out, err
	}
	err = respond.DecodeResponse(encoded, &out)
	return out, err
}
func actor(ctx context.Context) store.AuditActor {
	if c, ok := ctx.(*gin.Context); ok {
		if v, ok := c.Get("adminActor"); ok {
			if a, ok := v.(store.AuditActor); ok {
				return a
			}
		}
		return store.AuditActor{IP: c.ClientIP(), UserAgent: c.GetHeader("User-Agent")}
	}
	return store.AuditActor{}
}
func identity(ctx context.Context) (auth.Identity, error) {
	if c, ok := ctx.(*gin.Context); ok {
		if v, ok := c.Get("adminIdentity"); ok {
			if i, ok := v.(auth.Identity); ok {
				return i, nil
			}
		}
	}
	return auth.Identity{}, &domain.AppError{Code: domain.CodeUnauthenticated, HTTPStatus: 401}
}
func (h *Handler) Login(ctx context.Context, r adminapi.LoginRequestObject) (adminapi.LoginResponseObject, error) {
	if h.Auth == nil {
		return nil, domain.Internal(nil)
	}
	if r.Body == nil {
		return nil, domain.Validation()
	}
	data, err := h.Auth.Login(requestContext(ctx), r.Body.UserName, r.Body.Password, actor(ctx))
	return response[adminapi.Login200JSONResponse](data, err)
}
func (h *Handler) RefreshToken(ctx context.Context, r adminapi.RefreshTokenRequestObject) (adminapi.RefreshTokenResponseObject, error) {
	if h.Auth == nil {
		return nil, domain.Internal(nil)
	}
	if r.Body == nil {
		return nil, domain.Validation()
	}
	data, err := h.Auth.Refresh(requestContext(ctx), r.Body.RefreshToken, actor(ctx))
	return response[adminapi.RefreshToken200JSONResponse](data, err)
}
func (h *Handler) GetUserInfo(ctx context.Context, _ adminapi.GetUserInfoRequestObject) (adminapi.GetUserInfoResponseObject, error) {
	if h.Auth == nil {
		return nil, domain.Internal(nil)
	}
	i, err := identity(ctx)
	if err != nil {
		return nil, err
	}
	return response[adminapi.GetUserInfo200JSONResponse](i.UserInfo(), nil)
}
func (h *Handler) Logout(ctx context.Context, _ adminapi.LogoutRequestObject) (adminapi.LogoutResponseObject, error) {
	if h.Auth == nil {
		return nil, domain.Internal(nil)
	}
	i, err := identity(ctx)
	if err != nil {
		return nil, err
	}
	return response[adminapi.Logout200JSONResponse](nil, h.Auth.Logout(requestContext(ctx), i, actor(ctx)))
}
func (h *Handler) GetProfile(ctx context.Context, _ adminapi.GetProfileRequestObject) (adminapi.GetProfileResponseObject, error) {
	if h.Auth == nil {
		return nil, domain.Internal(nil)
	}
	i, err := identity(ctx)
	if err != nil {
		return nil, err
	}
	data, err := h.Auth.Profile(requestContext(ctx), i)
	return response[adminapi.GetProfile200JSONResponse](data, err)
}
func (h *Handler) UpdateProfile(ctx context.Context, r adminapi.UpdateProfileRequestObject) (adminapi.UpdateProfileResponseObject, error) {
	if h.Auth == nil {
		return nil, domain.Internal(nil)
	}
	i, err := identity(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, domain.Validation()
	}
	patch := auth.ProfilePatch{Value: *r.Body}
	if c, ok := ctx.(*gin.Context); ok {
		if raw, exists := c.Get("adminBody"); exists {
			if body, valid := raw.([]byte); valid {
				var fields map[string]json.RawMessage
				if err := json.Unmarshal(body, &fields); err != nil {
					return nil, domain.Validation()
				}
				_, patch.EmailSet = fields["email"]
				_, patch.AvatarURLSet = fields["avatarUrl"]
			}
		}
	}
	return response[adminapi.UpdateProfile200JSONResponse](nil, h.Auth.UpdateProfile(requestContext(ctx), i, patch, actor(ctx)))
}
func (h *Handler) ChangePassword(ctx context.Context, r adminapi.ChangePasswordRequestObject) (adminapi.ChangePasswordResponseObject, error) {
	if h.Auth == nil {
		return nil, domain.Internal(nil)
	}
	i, err := identity(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, domain.Validation()
	}
	return response[adminapi.ChangePassword200JSONResponse](nil, h.Auth.ChangePassword(requestContext(ctx), i, r.Body.OldPassword, r.Body.NewPassword, actor(ctx)))
}
