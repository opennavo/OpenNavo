package admin

import (
	"context"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/opennavo/opennavo/server/internal/domain"
	"github.com/opennavo/opennavo/server/internal/http/respond"
	"github.com/opennavo/opennavo/server/internal/i18n"
	"github.com/opennavo/opennavo/server/internal/service/management"
)

func (h *Handler) manage(ctx context.Context, op string, request any) (any, error) {
	var body []byte
	ci := false
	if c, ok := ctx.(*gin.Context); ok {
		if value, ok := c.Get("adminBody"); ok {
			body, _ = value.([]byte)
		}
		ci = c.GetBool("adminCI")
	}
	in, err := management.Decode(request, body, actor(ctx), ci)
	if err != nil {
		return nil, err
	}
	locale := "en-US"
	if c, ok := ctx.(*gin.Context); ok {
		locale = respond.Locale(c)
	}
	requestCtx := i18n.WithLocale(requestContext(ctx), locale)
	if current := domain.CurrentOperation(requestCtx); current != nil {
		current.Name = strings.ToLower(op[:1]) + op[1:]
	}
	return h.Management.Execute(requestCtx, op, in)
}
