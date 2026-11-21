package storage

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/opennavo/opennavo/server/internal/config"
)

func TestAnonymousPolicyAllowsOnlyTheFourReadPrefixes(t *testing.T) {
	encoded, err := PublicPolicy("opennavo")
	if err != nil {
		t.Fatal(err)
	}
	var policy struct {
		Statement []struct {
			Action   []string
			Resource []string
		}
	}
	if err := json.Unmarshal([]byte(encoded), &policy); err != nil {
		t.Fatal(err)
	}
	if len(policy.Statement) != 1 || len(policy.Statement[0].Action) != 1 || policy.Statement[0].Action[0] != "s3:GetObject" {
		t.Fatal("anonymous policy must never grant write or list access")
	}
	resources := policy.Statement[0].Resource
	if len(resources) != 4 {
		t.Fatal("unexpected public-prefix count")
	}
	for _, prefix := range []string{"icons/", "screenshots/", "snapshots/", "desktop/"} {
		if !slices.Contains(resources, "arn:aws:s3:::opennavo/"+prefix+"*") {
			t.Fatalf("missing prefix %s", prefix)
		}
	}
	if slices.Contains(resources, "arn:aws:s3:::opennavo/*") {
		t.Fatal("private keys are publicly readable")
	}
}

func TestNewDefaultsPrivateBucketToPublic(t *testing.T) {
	client, err := New(config.Config{
		S3Endpoint: "localhost:9000", S3Region: "us-east-1", S3Bucket: "opennavo",
		S3AccessKey: "fixture-access", S3SecretKey: "fixture-secret",
		CDNBaseURL: "http://localhost:9000/opennavo",
	})
	if err != nil {
		t.Fatal(err)
	}
	if client.PublicBucket != "opennavo" || client.PrivateBucket != "opennavo" {
		t.Fatalf("unexpected buckets: public=%q private=%q", client.PublicBucket, client.PrivateBucket)
	}
	if client.PublicAccess != config.S3PublicAccessBucketPolicy {
		t.Fatalf("unexpected public access mode: %q", client.PublicAccess)
	}
}

func TestNewUsesSeparatePrivateBucketForR2(t *testing.T) {
	client, err := New(config.Config{
		S3Endpoint: "account.r2.cloudflarestorage.com", S3Region: "auto", S3Bucket: "opennavo-public",
		S3PrivateBucket: "opennavo-private", S3PublicAccess: config.S3PublicAccessCustomDomain,
		S3AccessKey: "fixture-access", S3SecretKey: "fixture-secret", S3UseSSL: true,
		CDNBaseURL: "https://cdn.opennavo.example",
	})
	if err != nil {
		t.Fatal(err)
	}
	if client.PublicBucket != "opennavo-public" || client.PrivateBucket != "opennavo-private" {
		t.Fatalf("unexpected buckets: public=%q private=%q", client.PublicBucket, client.PrivateBucket)
	}
	if client.PublicAccess != config.S3PublicAccessCustomDomain {
		t.Fatalf("unexpected public access mode: %q", client.PublicAccess)
	}
}

func recordingS3(t *testing.T) (*Client, func() []string) {
	t.Helper()
	var mu sync.Mutex
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requests = append(requests, r.Method+" "+r.URL.RequestURI())
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)
	s3, err := minio.New(strings.TrimPrefix(server.URL, "http://"), &minio.Options{
		Creds: credentials.NewStaticV4("fixture-access", "fixture-secret", ""), Region: "auto",
	})
	if err != nil {
		t.Fatal(err)
	}
	return &Client{
		S3: s3, PublicBucket: "opennavo-public", PrivateBucket: "opennavo-private",
		PublicAccess: config.S3PublicAccessCustomDomain, ManageBuckets: false,
	}, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return slices.Clone(requests)
	}
}

func TestEnsureBucketsCustomDomainSkipsPublicPolicy(t *testing.T) {
	client, requests := recordingS3(t)
	if err := client.EnsureBuckets(context.Background(), "auto"); err != nil {
		t.Fatal(err)
	}
	seen := requests()
	if !slices.Contains(seen, "HEAD /opennavo-public/") || !slices.Contains(seen, "HEAD /opennavo-private/") {
		t.Fatalf("both buckets must be checked: %v", seen)
	}
	for _, request := range seen {
		if strings.Contains(request, "policy") {
			t.Fatalf("custom-domain mode must not write a bucket policy: %v", seen)
		}
	}
}

func TestEnsureBucketsBucketPolicyWritesPrefixPolicy(t *testing.T) {
	client, requests := recordingS3(t)
	client.PublicAccess = config.S3PublicAccessBucketPolicy
	if err := client.EnsureBuckets(context.Background(), "us-east-1"); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, request := range requests() {
		if strings.HasPrefix(request, "PUT /opennavo-public/") && strings.Contains(request, "policy=") {
			found = true
		}
	}
	if !found {
		t.Fatalf("bucket-policy mode must write the public prefix policy: %v", requests())
	}
}
