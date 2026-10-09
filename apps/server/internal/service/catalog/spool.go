package catalog

import (
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/opennavo/opennavo/server/internal/homebrew"
)

// Spool only raw definitions so installation declarations expanded per platform do not fill production tmpfs.
// Read back only after gzip finalization succeeds; download and normalization validation still precede all catalog batch writes.
type catalogSpool struct {
	file    *os.File
	writer  *gzip.Writer
	reader  *gzip.Reader
	encoder *json.Encoder
	decoder *json.Decoder
}

func newCatalogSpool() (*catalogSpool, error) {
	file, err := os.CreateTemp("", "opennavo-catalog-*.jsonl.gz")
	if err != nil {
		return nil, fmt.Errorf("create catalog spool: %w", err)
	}
	writer := gzip.NewWriter(file)
	return &catalogSpool{file: file, writer: writer, encoder: json.NewEncoder(writer)}, nil
}

func (s *catalogSpool) append(raw json.RawMessage) error {
	if err := s.encoder.Encode(raw); err != nil {
		return fmt.Errorf("write catalog spool: %w", err)
	}
	return nil
}

func (s *catalogSpool) rewind() error {
	if err := s.writer.Close(); err != nil {
		return fmt.Errorf("finish catalog spool: %w", err)
	}
	s.writer = nil
	if _, err := s.file.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("rewind catalog spool: %w", err)
	}
	reader, err := gzip.NewReader(s.file)
	if err != nil {
		return fmt.Errorf("open catalog spool: %w", err)
	}
	s.reader, s.decoder = reader, json.NewDecoder(reader)
	return nil
}

func (s *catalogSpool) next() (homebrew.Package, error) {
	var raw json.RawMessage
	if err := s.decoder.Decode(&raw); err != nil {
		return homebrew.Package{}, fmt.Errorf("read catalog spool: %w", err)
	}
	item, err := homebrew.Normalize("cask", raw)
	if err != nil {
		return homebrew.Package{}, fmt.Errorf("normalize catalog spool: %w", err)
	}
	return item, nil
}

func (s *catalogSpool) close() error {
	var err error
	if s.writer != nil {
		err = s.writer.Close()
	}
	if s.reader != nil {
		err = errors.Join(err, s.reader.Close())
	}
	return errors.Join(err, s.file.Close(), os.Remove(s.file.Name()))
}
