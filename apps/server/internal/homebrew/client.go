package homebrew

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/opennavo/opennavo/server/internal/fetch"
)

const CatalogLimit = 64 << 20

type Conditional struct {
	ETag         string `json:"etag"`
	LastModified string `json:"lastModified"`
}
type StreamResult struct {
	Conditional
	NotModified bool
	Fetched     int
}
type Client struct {
	BaseURL, UserAgent string
	HTTP               *http.Client
	Limit              int64
}

func NewClient(baseURL, userAgent string) *Client {
	return &Client{BaseURL: strings.TrimRight(baseURL, "/"), UserAgent: userAgent, HTTP: fetch.NewClient(120 * time.Second), Limit: CatalogLimit}
}

// Save conditional headers only after Stream succeeds, so a later 304 cannot skip an interrupted download.
func (c *Client) Stream(ctx context.Context, kind string, previous Conditional, consume func(Package) error) (StreamResult, error) {
	var result StreamResult
	if kind != "cask" && kind != "formula" {
		return result, errors.New("invalid catalog kind")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/"+kind+".json", nil)
	if err != nil {
		return result, fmt.Errorf("create catalog request: %w", err)
	}
	if err := fetch.ValidateURL(request.URL); err != nil {
		return result, err
	}
	request.Header.Set("User-Agent", c.UserAgent)
	if previous.ETag != "" {
		request.Header.Set("If-None-Match", previous.ETag)
	}
	if previous.LastModified != "" {
		request.Header.Set("If-Modified-Since", previous.LastModified)
	}
	response, err := c.HTTP.Do(request) // #nosec G704 -- URL is validated; the production client validates and pins public IPs in DialContext and on every redirect.
	if err != nil {
		return result, fmt.Errorf("fetch catalog: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode == http.StatusNotModified {
		result.Conditional = previous
		result.NotModified = true
		return result, nil
	}
	if response.StatusCode != http.StatusOK {
		return result, fmt.Errorf("catalog HTTP status %d", response.StatusCode)
	}
	if response.ContentLength > c.Limit {
		return result, errors.New("catalog exceeds size limit")
	}
	reader := &io.LimitedReader{R: response.Body, N: c.Limit + 1}
	decoder := json.NewDecoder(reader)
	token, err := decoder.Token()
	if err != nil || token != json.Delim('[') {
		return result, errors.New("catalog must be a JSON array")
	}
	for decoder.More() {
		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			return result, fmt.Errorf("decode catalog item: %w", err)
		}
		item, err := Normalize(kind, raw)
		if err != nil {
			return result, err
		}
		if err := consume(item); err != nil {
			return result, fmt.Errorf("consume catalog item: %w", err)
		}
		result.Fetched++
	}
	if token, err := decoder.Token(); err != nil || token != json.Delim(']') {
		return result, errors.New("catalog array is incomplete")
	}
	var extra json.RawMessage
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return result, errors.New("catalog has trailing or truncated data")
	}
	if reader.N <= 0 {
		return result, errors.New("catalog exceeds size limit")
	}
	result.Conditional = Conditional{ETag: response.Header.Get("ETag"), LastModified: response.Header.Get("Last-Modified")}
	return result, nil
}
