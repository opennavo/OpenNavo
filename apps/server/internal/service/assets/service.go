package assets

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/minio/minio-go/v7"
	"github.com/opennavo/opennavo/server/gen/adminapi"
	"github.com/opennavo/opennavo/server/internal/domain"
	"github.com/opennavo/opennavo/server/internal/images"
	"github.com/opennavo/opennavo/server/internal/storage"
	"github.com/opennavo/opennavo/server/internal/store"
)

type Objects interface {
	Put(context.Context, string, []byte, string) error
	URL(string) string
}
type S3Objects struct{ Client *storage.Client }

func (s S3Objects) Put(ctx context.Context, key string, data []byte, mime string) error {
	cacheControl := "public, max-age=31536000, immutable"
	if strings.HasSuffix(key, "latest.json") {
		cacheControl = "public, max-age=60"
	}
	_, err := s.Client.S3.PutObject(ctx, s.Client.Bucket, key, bytes.NewReader(data), int64(len(data)), minio.PutObjectOptions{ContentType: mime, CacheControl: cacheControl})
	return err
}
func (s S3Objects) URL(key string) string {
	return strings.TrimRight(s.Client.CDNBaseURL, "/") + "/" + key
}

type Service struct {
	URLClient *http.Client
	Store     *store.Store
	Objects   Objects
}

func (s *Service) save(ctx context.Context, kind, prefix string, variants []images.Variant, sourceURL *string, actor *store.AuditActor) (store.Asset, error) {
	var primary store.Asset
	for index, v := range variants {
		key := prefix + variants[0].SHA256[:12] + "-" + strconv.Itoa(v.Width) + ".png"
		if err := s.Objects.Put(ctx, key, v.PNG, "image/png"); err != nil {
			return primary, fmt.Errorf("upload normalized image: %w", err)
		}
		if index == 0 {
			primary = store.Asset{Kind: kind, StorageKey: key, URL: s.Objects.URL(key), MIME: "image/png", Width: v.Width, Height: v.Height, Bytes: int64(len(v.PNG)), SHA256: v.SHA256, SourceURL: sourceURL}
			if actor != nil {
				primary.CreatedBy = actor.ID
			}
		}
	}
	return s.Store.SaveAsset(ctx, primary, actor)
}
func (s *Service) Upload(ctx context.Context, kind string, data []byte, sourceURL *string, actor store.AuditActor) (adminapi.Asset, error) {
	if kind != "icon" && kind != "screenshot" && kind != "cover" && kind != "og" {
		return adminapi.Asset{}, domain.Validation()
	}
	variants, _, err := images.Process(data, kind)
	if err != nil {
		return adminapi.Asset{}, &domain.AppError{Code: domain.CodeInvalidUpload, HTTPStatus: 400}
	}
	hash := sha256.Sum256(data)
	prefix := "screenshots/uploads/" + kind + "/"
	if kind == "icon" {
		prefix = "icons/uploads/"
	}
	prefix += hex.EncodeToString(hash[:6]) + "/"
	asset, err := s.save(ctx, kind, prefix, variants, sourceURL, &actor)
	if err != nil {
		return adminapi.Asset{}, err
	}
	return adminapi.Asset{Id: asset.ID, Kind: adminapi.AssetKind(asset.Kind), Url: asset.URL, Mime: asset.MIME, Width: &asset.Width, Height: &asset.Height, Bytes: asset.Bytes, Sha256: asset.SHA256, CreateTime: asset.CreatedAt.UTC()}, nil
}

// Preview validates and computes image metadata without accessing object storage or the database.
func (s *Service) Preview(kind string, data []byte) (map[string]any, error) {
	if kind != "icon" && kind != "screenshot" && kind != "cover" && kind != "og" {
		return nil, domain.Validation()
	}
	variants, _, err := images.Process(data, kind)
	if err != nil {
		return nil, &domain.AppError{Code: domain.CodeInvalidUpload, HTTPStatus: 400}
	}
	v := variants[0]
	return map[string]any{"kind": kind, "width": v.Width, "height": v.Height, "bytes": len(v.PNG), "sha256": v.SHA256}, nil
}
func (s S3Objects) Read(ctx context.Context, key string) ([]byte, error) {
	object, err := s.Client.S3.GetObject(ctx, s.Client.Bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = object.Close() }()
	return io.ReadAll(io.LimitReader(object, 5*1024*1024+1))
}
func (s *Service) IconAccent(ctx context.Context, id int64) (*string, error) {
	asset, err := s.Store.AssetByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if asset.Kind != "icon" {
		return nil, domain.Validation()
	}
	reader, ok := s.Objects.(interface {
		Read(context.Context, string) ([]byte, error)
	})
	if !ok {
		return nil, domain.Internal(nil)
	}
	data, err := reader.Read(ctx, asset.StorageKey)
	if err != nil {
		return nil, err
	}
	_, accent, err := images.Process(data, "icon")
	return accent, err
}
