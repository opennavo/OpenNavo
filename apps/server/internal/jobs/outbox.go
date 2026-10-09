package jobs

import (
	"encoding/json"
	"errors"

	"github.com/opennavo/opennavo/server/internal/domain"
)

// ErrOutboxDeferred means delivery is still required; do not acknowledge deletion of the persisted job.
var ErrOutboxDeferred = errors.New("outbox delivery deferred")

func OutboxDeliveryError(kind string, err error) error {
	var app *domain.AppError
	if errors.As(err, &app) && app.Code == domain.CodeInvalidState {
		// Retranslation has refreshed the writeback version; an in-flight job with the same payload no longer guarantees fulfillment of the latest request.
		if kind == "translate:content" {
			return ErrOutboxDeferred
		}
		return nil
	}
	return err
}

type OutboxPayload struct {
	Payload
	Metadata *Metadata `json:"metadata,omitempty"`
}

func DecodeOutbox(raw json.RawMessage) (Payload, Metadata, error) {
	var out OutboxPayload
	err := json.Unmarshal(raw, &out)
	meta := Metadata{Trigger: "event"}
	if out.Metadata != nil {
		meta = *out.Metadata
	}
	return out.Payload, meta, err
}
