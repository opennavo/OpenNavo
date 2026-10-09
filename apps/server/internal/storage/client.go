package storage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/opennavo/opennavo/server/internal/config"
)

var PublicPrefixes = []string{"icons/", "screenshots/", "snapshots/", "desktop/"}

type Client struct {
	S3         *minio.Client
	Bucket     string
	CDNBaseURL string
}

func New(cfg config.Config) (*Client, error) {
	client, err := minio.New(cfg.S3Endpoint, &minio.Options{Creds: credentials.NewStaticV4(cfg.S3AccessKey, cfg.S3SecretKey, ""), Secure: cfg.S3UseSSL, Region: cfg.S3Region})
	if err != nil {
		return nil, errors.New("invalid object-storage configuration")
	}
	return &Client{S3: client, Bucket: cfg.S3Bucket, CDNBaseURL: cfg.CDNBaseURL}, nil
}
func PublicPolicy(bucket string) (string, error) {
	resources := make([]string, 0, len(PublicPrefixes))
	for _, prefix := range PublicPrefixes {
		resources = append(resources, "arn:aws:s3:::"+bucket+"/"+prefix+"*")
	}
	policy := struct {
		Version   string           `json:"Version"`
		Statement []map[string]any `json:"Statement"`
	}{Version: "2012-10-17", Statement: []map[string]any{{"Effect": "Allow", "Principal": map[string][]string{"AWS": {"*"}}, "Action": []string{"s3:GetObject"}, "Resource": resources}}}
	encoded, err := json.Marshal(policy)
	if err != nil {
		return "", fmt.Errorf("encode public-prefix policy: %w", err)
	}
	return string(encoded), nil
}
func (c *Client) EnsurePublicPrefixes(ctx context.Context, region string) error {
	exists, err := c.S3.BucketExists(ctx, c.Bucket)
	if err != nil {
		return fmt.Errorf("check bucket: %w", err)
	}
	if !exists {
		if err := c.S3.MakeBucket(ctx, c.Bucket, minio.MakeBucketOptions{Region: region}); err != nil && minio.ToErrorResponse(err).Code != "BucketAlreadyOwnedByYou" {
			return fmt.Errorf("create bucket: %w", err)
		}
	}
	policy, err := PublicPolicy(c.Bucket)
	if err != nil {
		return err
	}
	if err := c.S3.SetBucketPolicy(ctx, c.Bucket, policy); err != nil {
		return fmt.Errorf("set public-prefix policy: %w", err)
	}
	return nil
}
