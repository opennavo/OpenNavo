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
	S3            *minio.Client
	PublicBucket  string
	PrivateBucket string
	CDNBaseURL    string
	// PublicAccess is config.S3PublicAccessBucketPolicy for MinIO-compatible prefix policies or
	// config.S3PublicAccessCustomDomain for R2, where public access is configured on the bucket domain.
	PublicAccess  string
	ManageBuckets bool
}

func New(cfg config.Config) (*Client, error) {
	client, err := minio.New(cfg.S3Endpoint, &minio.Options{Creds: credentials.NewStaticV4(cfg.S3AccessKey, cfg.S3SecretKey, ""), Secure: cfg.S3UseSSL, Region: cfg.S3Region})
	if err != nil {
		return nil, errors.New("invalid object-storage configuration")
	}
	publicAccess := cfg.S3PublicAccess
	if publicAccess == "" {
		publicAccess = config.S3PublicAccessBucketPolicy
	}
	privateBucket := cfg.S3PrivateBucket
	if privateBucket == "" {
		privateBucket = cfg.S3Bucket
	}
	return &Client{
		S3:            client,
		PublicBucket:  cfg.S3Bucket,
		PrivateBucket: privateBucket,
		CDNBaseURL:    cfg.CDNBaseURL,
		PublicAccess:  publicAccess,
		ManageBuckets: cfg.S3ManageBuckets,
	}, nil
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
func (c *Client) ensureBucket(ctx context.Context, bucket, region string) error {
	if bucket == "" {
		return errors.New("bucket name is required")
	}
	exists, err := c.S3.BucketExists(ctx, bucket)
	if err != nil {
		return fmt.Errorf("check bucket: %w", err)
	}
	if exists {
		return nil
	}
	if !c.ManageBuckets {
		return errors.New("bucket does not exist; create it in the object-storage console or enable S3_MANAGE_BUCKETS")
	}
	if err := c.S3.MakeBucket(ctx, bucket, minio.MakeBucketOptions{Region: region}); err != nil && minio.ToErrorResponse(err).Code != "BucketAlreadyOwnedByYou" {
		return fmt.Errorf("create bucket: %w", err)
	}
	return nil
}

// EnsureBuckets creates or verifies the public and private buckets and, for MinIO-compatible
// storage, restores the public-prefix policy. R2 public access is bucket-wide through a custom
// domain, so it must use a separate private bucket and no policy is written here.
func (c *Client) EnsureBuckets(ctx context.Context, region string) error {
	if err := c.ensureBucket(ctx, c.PublicBucket, region); err != nil {
		return fmt.Errorf("public bucket %q: %w", c.PublicBucket, err)
	}
	if c.PrivateBucket != c.PublicBucket {
		if err := c.ensureBucket(ctx, c.PrivateBucket, region); err != nil {
			return fmt.Errorf("private bucket %q: %w", c.PrivateBucket, err)
		}
	}
	if c.PublicAccess == config.S3PublicAccessCustomDomain {
		return nil
	}
	policy, err := PublicPolicy(c.PublicBucket)
	if err != nil {
		return err
	}
	if err := c.S3.SetBucketPolicy(ctx, c.PublicBucket, policy); err != nil {
		return fmt.Errorf("set public-prefix policy: %w", err)
	}
	return nil
}
