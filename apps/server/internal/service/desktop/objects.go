package desktop

import (
	"context"
	"errors"

	"github.com/minio/minio-go/v7"
	"github.com/opennavo/opennavo/server/internal/service/assets"
)

type S3Objects struct{ assets.S3Objects }

func (s S3Objects) Read(ctx context.Context, key string) ([]byte, error) {
	data, err := s.S3Objects.Read(ctx, key)
	if err != nil {
		r := minio.ToErrorResponse(err)
		if r.Code == "NoSuchKey" || r.Code == "NoSuchObject" {
			return nil, nil
		}
		return nil, err
	}
	if len(data) > 1<<20 {
		return nil, errors.New("updater manifest exceeds limit")
	}
	return data, nil
}
func (s S3Objects) Delete(ctx context.Context, key string) error {
	return s.Client.S3.RemoveObject(ctx, s.Client.Bucket, key, minio.RemoveObjectOptions{})
}
