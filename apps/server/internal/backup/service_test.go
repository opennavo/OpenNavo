package backup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

type fakeTools struct {
	restores int
	files    []string
}

func (p *fakeTools) Dump(_ context.Context, file string) error {
	p.files = append(p.files, file)
	return os.WriteFile(file, []byte("PGDMP fixture"), 0600)
}
func (p *fakeTools) Restore(_ context.Context, file string) error {
	p.files = append(p.files, file)
	p.restores++
	return nil
}

type fakeObjects struct {
	hash    string
	data    []byte
	rows    []Object
	deleted []string
	key     string
}

func (s *fakeObjects) Put(_ context.Context, key, file, hash string) error {
	s.key = key
	s.hash = hash
	var err error
	s.data, err = os.ReadFile(file) // #nosec G304 -- The test service supplies its own temporary files, never external paths.
	return err
}
func (s *fakeObjects) Get(_ context.Context, _ string, file string) (string, error) {
	return s.hash, os.WriteFile(file, s.data, 0600)
}
func (s *fakeObjects) List(context.Context, string) ([]Object, error) { return s.rows, nil }
func (s *fakeObjects) Delete(_ context.Context, key string) error {
	s.deleted = append(s.deleted, key)
	return nil
}
func TestBackupRetentionChecksumAndScope(t *testing.T) {
	now := time.Date(2026, 10, 5, 2, 0, 0, 0, time.UTC)
	tools := &fakeTools{}
	objects := &fakeObjects{}
	objects.rows = []Object{{Key: "backups/postgres/opennavo/expired.dump", Modified: now.AddDate(0, 0, -31)}, {Key: "backups/postgres/opennavo/boundary.dump", Modified: now.AddDate(0, 0, -30)}, {Key: "backups/postgres/other/expired.dump", Modified: now.AddDate(0, 0, -31)}}
	svc := &Service{Database: "opennavo", Tools: tools, Objects: objects, Now: func() time.Time { return now }}
	key, err := svc.Create(context.Background())
	require.NoError(t, err)
	require.True(t, strings.HasPrefix(key, "backups/postgres/opennavo/20261005T020000Z-"))
	require.Equal(t, []string{"backups/postgres/opennavo/expired.dump"}, objects.deleted)
	sum := sha256.Sum256(objects.data)
	require.Equal(t, hex.EncodeToString(sum[:]), objects.hash)
	require.NoError(t, svc.Restore(context.Background(), key))
	require.Equal(t, 1, tools.restores)
	objects.data = []byte("corrupted")
	require.ErrorContains(t, svc.Restore(context.Background(), key), "checksum")
	require.Equal(t, 1, tools.restores)
	require.Error(t, svc.Restore(context.Background(), "backups/postgres/other/foreign.dump"))
	require.Error(t, svc.Restore(context.Background(), "backups/postgres/opennavo/../foreign.dump"))
	for _, file := range tools.files {
		_, err := os.Stat(file)
		require.True(t, os.IsNotExist(err))
	}
}
func TestPGCredentialsUseEnvironment(t *testing.T) {
	tools, err := NewPGTools("postgres://opennavo_app:fixture-password@postgres:5432/opennavo?sslmode=disable")
	require.NoError(t, err)
	require.Contains(t, tools.Environment, "PGPASSWORD=fixture-password")
	require.Contains(t, tools.Environment, "PGDATABASE=opennavo")
	_, err = NewPGTools("postgres://user:fixture-password@postgres/path/escape")
	require.Error(t, err)
}

func TestNextRunUsesUTCAndDoesNotSkipToday(t *testing.T) {
	for _, row := range []struct{ now, next string }{
		{"2026-10-05T00:30:00Z", "2026-10-05T02:00:00Z"},
		{"2026-10-05T02:00:00Z", "2026-10-06T02:00:00Z"},
		{"2026-10-05T14:00:00Z", "2026-10-06T02:00:00Z"},
		{"2026-10-05T08:30:00+08:00", "2026-10-05T02:00:00Z"},
	} {
		now, err := time.Parse(time.RFC3339, row.now)
		require.NoError(t, err)
		require.Equal(t, row.next, NextRun(now).Format(time.RFC3339))
	}
}
