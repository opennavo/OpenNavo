package assets

import (
	"bytes"
	"context"
	"image"
	"image/png"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestImageProcessingWaitsForAFreeSlot(t *testing.T) {
	for range cap(imageSlots) {
		imageSlots <- struct{}{}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, _, err := processImage(ctx, nil, "screenshot")
	require.ErrorIs(t, err, context.DeadlineExceeded, "a full pool must not start another decode")
	for range cap(imageSlots) {
		<-imageSlots
	}

	var encoded bytes.Buffer
	require.NoError(t, png.Encode(&encoded, image.NewNRGBA(image.Rect(0, 0, 320, 200))))
	variants, _, err := processImage(context.Background(), encoded.Bytes(), "screenshot")
	require.NoError(t, err)
	require.Len(t, variants, 2)
	require.Empty(t, imageSlots, "slots are released after processing")
}
