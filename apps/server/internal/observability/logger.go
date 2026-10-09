package observability

import (
	"io"
	"log/slog"
	"time"
)

func NewLogger(out io.Writer, level string) *slog.Logger {
	var parsed slog.Level
	if err := parsed.UnmarshalText([]byte(level)); err != nil {
		parsed = slog.LevelInfo
	}
	return slog.New(slog.NewJSONHandler(out, &slog.HandlerOptions{Level: parsed, ReplaceAttr: func(groups []string, attr slog.Attr) slog.Attr {
		if len(groups) == 0 && attr.Key == slog.TimeKey {
			return slog.String("ts", attr.Value.Time().UTC().Format(time.RFC3339Nano))
		}
		return attr
	}}))
}
