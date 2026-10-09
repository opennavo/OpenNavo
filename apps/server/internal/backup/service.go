package backup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"
	"github.com/opennavo/opennavo/server/internal/storage"
)

type Tools interface {
	Dump(context.Context, string) error
	Restore(context.Context, string) error
}
type Object struct {
	Key      string
	Modified time.Time
}
type Objects interface {
	Put(context.Context, string, string, string) error
	Get(context.Context, string, string) (string, error)
	List(context.Context, string) ([]Object, error)
	Delete(context.Context, string) error
}
type Service struct {
	Database string
	Tools    Tools
	Objects  Objects
	Now      func() time.Time
}

var databaseName = regexp.MustCompile(`^[A-Za-z0-9_]+$`)

func NextRun(now time.Time) time.Time {
	now = now.UTC()
	next := now.Truncate(24 * time.Hour).Add(2 * time.Hour)
	if !next.After(now) {
		next = next.Add(24 * time.Hour)
	}
	return next
}

func Prefix(database string) (string, error) {
	if !databaseName.MatchString(database) {
		return "", errors.New("invalid backup database")
	}
	return "backups/postgres/" + database + "/", nil
}
func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}
func fileHash(name string) (string, error) {
	f, err := os.Open(name) // #nosec G304 -- Files come from a process-created 0700 temporary directory; network paths are not accepted.
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
func (s *Service) Create(ctx context.Context) (string, error) {
	prefix, err := Prefix(s.Database)
	if err != nil {
		return "", err
	}
	folder, err := os.MkdirTemp("", "opennavo-backup-")
	if err != nil {
		return "", err
	}
	defer func() { _ = os.RemoveAll(folder) }()
	file := filepath.Join(folder, "database.dump")
	if err := s.Tools.Dump(ctx, file); err != nil {
		return "", err
	}
	if err := os.Chmod(file, 0600); err != nil {
		return "", err
	}
	hash, err := fileHash(file)
	if err != nil {
		return "", err
	}
	key := prefix + s.now().Format("20060102T150405Z") + "-" + uuid.NewString() + ".dump"
	if err := s.Objects.Put(ctx, key, file, hash); err != nil {
		return "", err
	}
	if err := s.Prune(ctx); err != nil {
		return key, err
	}
	return key, nil
}
func (s *Service) Prune(ctx context.Context) error {
	prefix, err := Prefix(s.Database)
	if err != nil {
		return err
	}
	rows, err := s.Objects.List(ctx, prefix)
	if err != nil {
		return err
	}
	before := s.now().AddDate(0, 0, -30)
	for _, row := range rows {
		if strings.HasPrefix(row.Key, prefix) && row.Modified.Before(before) {
			if err := s.Objects.Delete(ctx, row.Key); err != nil {
				return err
			}
		}
	}
	return nil
}
func (s *Service) Restore(ctx context.Context, key string) error {
	prefix, err := Prefix(s.Database)
	if err != nil {
		return err
	}
	if !strings.HasPrefix(key, prefix) || strings.Contains(key, "..") || strings.ContainsAny(strings.TrimPrefix(key, prefix), "/\\\r\n") || !strings.HasSuffix(key, ".dump") {
		return errors.New("invalid backup object key")
	}
	folder, err := os.MkdirTemp("", "opennavo-restore-")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(folder) }()
	file := filepath.Join(folder, "database.dump")
	expected, err := s.Objects.Get(ctx, key, file)
	if err != nil {
		return err
	}
	actual, err := fileHash(file)
	if err != nil {
		return err
	}
	if len(expected) != 64 || expected != actual {
		return errors.New("backup checksum mismatch")
	}
	return s.Tools.Restore(ctx, file)
}

type PGTools struct {
	Environment []string
	Database    string
}

func NewPGTools(databaseURL string) (PGTools, error) {
	u, err := url.Parse(databaseURL)
	if err != nil || u.Hostname() == "" || u.User == nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
		return PGTools{}, errors.New("invalid backup connection")
	}
	database := strings.TrimPrefix(u.Path, "/")
	if _, err := Prefix(database); err != nil {
		return PGTools{}, err
	}
	password, _ := u.User.Password()
	port := u.Port()
	if port == "" {
		port = "5432"
	}
	ssl := u.Query().Get("sslmode")
	if ssl == "" {
		ssl = "require"
	}
	values := map[string]string{"PGHOST": u.Hostname(), "PGPORT": port, "PGUSER": u.User.Username(), "PGPASSWORD": password, "PGDATABASE": database, "PGSSLMODE": ssl, "PGCONNECT_TIMEOUT": "10"}
	environment := []string{}
	for _, v := range os.Environ() {
		key, _, _ := strings.Cut(v, "=")
		if _, ok := values[key]; !ok {
			environment = append(environment, v)
		}
	}
	for key, value := range values {
		environment = append(environment, key+"="+value)
	}
	return PGTools{Environment: environment, Database: database}, nil
}
func (p PGTools) command(ctx context.Context, name string, args ...string) error {
	command := exec.CommandContext(ctx, name, args...) // #nosec G204 -- Callers fix the command to pg_dump/pg_restore; arguments contain only fixed flags and this process's temporary files.
	command.Env = p.Environment
	if err := command.Run(); err != nil {
		return fmt.Errorf("PostgreSQL backup tool failed: %w", err)
	}
	return nil
}
func (p PGTools) Dump(ctx context.Context, file string) error {
	return p.command(ctx, "pg_dump", "--format=custom", "--compress=gzip:6", "--no-owner", "--no-privileges", "--file", file)
}
func (p PGTools) Restore(ctx context.Context, file string) error {
	return p.command(ctx, "pg_restore", "--dbname", p.Database, "--clean", "--if-exists", "--no-owner", "--no-privileges", "--single-transaction", "--exit-on-error", file)
}

type S3Objects struct{ Client *storage.Client }

func (s S3Objects) Put(ctx context.Context, key, file, hash string) error {
	_, err := s.Client.S3.FPutObject(ctx, s.Client.Bucket, key, file, minio.PutObjectOptions{ContentType: "application/octet-stream", CacheControl: "private, no-store", UserMetadata: map[string]string{"sha256": hash}})
	return err
}
func (s S3Objects) Get(ctx context.Context, key, file string) (string, error) {
	info, err := s.Client.S3.StatObject(ctx, s.Client.Bucket, key, minio.StatObjectOptions{})
	if err != nil {
		return "", err
	}
	if err := s.Client.S3.FGetObject(ctx, s.Client.Bucket, key, file, minio.GetObjectOptions{}); err != nil {
		return "", err
	}
	for key, value := range info.UserMetadata {
		if strings.EqualFold(key, "sha256") {
			return value, nil
		}
	}
	return "", nil
}
func (s S3Objects) List(ctx context.Context, prefix string) ([]Object, error) {
	rows := []Object{}
	for item := range s.Client.S3.ListObjects(ctx, s.Client.Bucket, minio.ListObjectsOptions{Prefix: prefix, Recursive: true}) {
		if item.Err != nil {
			return nil, item.Err
		}
		rows = append(rows, Object{Key: item.Key, Modified: item.LastModified})
	}
	return rows, nil
}
func (s S3Objects) Delete(ctx context.Context, key string) error {
	return s.Client.S3.RemoveObject(ctx, s.Client.Bucket, key, minio.RemoveObjectOptions{})
}
