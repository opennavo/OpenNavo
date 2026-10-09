package homebrew

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/opennavo/opennavo/server/internal/fetch"
)

type AnalyticsItem struct {
	Formula string `json:"formula"`
	Cask    string `json:"cask"`
	Count   string `json:"count"`
}
type Analytics struct {
	Items     []AnalyticsItem `json:"items"`
	StartDate string          `json:"start_date"`
	EndDate   string          `json:"end_date"`
}

var countPattern = regexp.MustCompile(`^(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)$`)

func ParseCount(value string) (int64, error) {
	if !countPattern.MatchString(value) {
		return 0, errors.New("invalid analytics count")
	}
	count, err := strconv.ParseInt(strings.ReplaceAll(value, ",", ""), 10, 32)
	if err != nil {
		return 0, fmt.Errorf("parse analytics count: %w", err)
	}
	return count, nil
}

func (c *Client) FetchAnalytics(ctx context.Context, category, period string) (Analytics, error) {
	var result Analytics
	if period != "30d" && period != "90d" && period != "365d" {
		return result, errors.New("invalid analytics period")
	}
	switch category {
	case "cask":
		category += "-install"
	case "install", "install-on-request":
	default:
		return result, errors.New("invalid analytics category")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/analytics/"+category+"/"+period+".json", nil)
	if err != nil {
		return result, fmt.Errorf("create analytics request: %w", err)
	}
	if err := fetch.ValidateURL(request.URL); err != nil {
		return result, err
	}
	request.Header.Set("User-Agent", c.UserAgent)
	response, err := c.HTTP.Do(request) // #nosec G704 -- The shared fetch client validates URLs and public IPs, including redirects.
	if err != nil {
		return result, fmt.Errorf("fetch analytics: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return result, fmt.Errorf("analytics HTTP status %d", response.StatusCode)
	}
	if response.ContentLength > c.Limit {
		return result, errors.New("analytics exceeds size limit")
	}
	reader := &io.LimitedReader{R: response.Body, N: c.Limit + 1}
	decoder := json.NewDecoder(reader)
	if err := decoder.Decode(&result); err != nil {
		return result, fmt.Errorf("decode analytics: %w", err)
	}
	var extra json.RawMessage
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return result, errors.New("analytics has trailing or truncated data")
	}
	if reader.N <= 0 {
		return result, errors.New("analytics exceeds size limit")
	}
	if result.Items == nil {
		return result, errors.New("analytics items are missing")
	}
	return result, nil
}
