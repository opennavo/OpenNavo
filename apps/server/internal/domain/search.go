package domain

type SearchInput struct {
	Query, Kind, Category, Locale, Platform string
	Current, Size                           int
	IncludeDisabled                         bool
}
type SearchMatch struct {
	ID          int64
	Score       float64
	MatchedName *string
}
type SearchResult struct {
	Records       []SearchMatch
	Total         int64
	QueryID       string
	ExpandedTerms []string
}
type Suggestion struct {
	SourceLocale      string  `json:"sourceLocale"`
	MachineTranslated bool    `json:"machineTranslated"`
	Type              string  `json:"type"`
	Kind              *string `json:"kind"`
	Token             *string `json:"token"`
	Slug              *string `json:"slug"`
	Name              string  `json:"name"`
	Summary           *string `json:"summary"`
	IconURL           *string `json:"iconUrl"`
	Version           *string `json:"version"`
}
type SearchQueryLog struct {
	ID                                  int64
	Query, Normalized, Locale, Platform string
	ResultCount                         int64
}
