package domain

type AnalyticsPackage struct {
	ID                          int64
	Kind, Token, FullToken, Tap string
}
type AnalyticsRow struct {
	ID                                        int64
	Installs30d, Installs90d, Installs365d    int64
	OnRequest30d, OnRequest90d, OnRequest365d int64
	Popularity                                float64
	IsLibrary                                 bool
}
