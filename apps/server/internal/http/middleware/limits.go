package middleware

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/opennavo/opennavo/server/internal/domain"
	"github.com/opennavo/opennavo/server/internal/http/respond"
)

const JSONBodyLimit = 1024 * 1024
const RequestTargetLimit = 16 * 1024
const QueryPairLimit = 64

// RequestBounds limits transport resources before contract decoding; OpenAPI still validates field limits.
func RequestBounds(admin bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		target := c.Request.URL.RequestURI()
		pairs := 0
		if c.Request.URL.RawQuery != "" {
			pairs = strings.Count(c.Request.URL.RawQuery, "&") + 1
		}
		if len(target) > RequestTargetLimit || pairs > QueryPairLimit || c.Request.ContentLength > JSONBodyLimit {
			respond.Error(c, domain.Validation(), admin)
			return
		}
		if c.Request.Body != nil {
			// Limit actual reads even when Content-Length is absent or forged; checking the declared length alone is insufficient.
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, JSONBodyLimit)
		}
		c.Next()
	}
}
