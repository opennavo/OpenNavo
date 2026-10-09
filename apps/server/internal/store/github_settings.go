package store

import (
	"context"

	"github.com/opennavo/opennavo/server/internal/config"
)

type GitHubSettings struct {
	TokenCiphertext string `json:"-"`
}

func (s *Store) GitHubSettings(ctx context.Context) (GitHubSettings, error) {
	var settings GitHubSettings
	err := s.DB.WithContext(ctx).Table("github_settings").Select("token_ciphertext").Where("id=true").Take(&settings).Error
	return settings, err
}

// Read independent credentials per request; never cache tokens or mutate the worker's shared configuration.
func (s *Store) GitHubToken(ctx context.Context, cfg config.Config) (string, error) {
	settings, err := s.GitHubSettings(ctx)
	if err != nil {
		return "", err
	}
	if settings.TokenCiphertext != "" {
		return cfg.DecryptGitHubToken(settings.TokenCiphertext)
	}
	return "", nil
}
