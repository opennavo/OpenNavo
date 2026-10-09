package management

import (
	"context"

	"github.com/opennavo/opennavo/server/internal/domain"
	"github.com/opennavo/opennavo/server/internal/store"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func githubView(settings store.GitHubSettings) map[string]any {
	source := "none"
	if settings.TokenCiphertext != "" {
		source = "admin"
	}
	return map[string]any{"tokenConfigured": source != "none", "tokenSource": source}
}

func validateGitHubSettings(body map[string]any) error {
	if value, present := body["token"]; present {
		token, ok := value.(string)
		if !ok || len(token) > 4096 || (token != "" && boolean(body, "clearToken")) {
			return domain.Validation()
		}
		for _, char := range token {
			if char < '!' || char > '~' {
				return domain.Validation()
			}
		}
	}
	if value, present := body["clearToken"]; present {
		if _, ok := value.(bool); !ok {
			return domain.Validation()
		}
	}
	return nil
}

func (s *Service) githubSettings(ctx context.Context, op string, in Input) (any, error) {
	if op == "GetGitHubSettings" {
		settings, err := s.Store.GitHubSettings(ctx)
		if err != nil {
			return nil, err
		}
		return githubView(settings), nil
	}
	if err := validateGitHubSettings(in.Body); err != nil {
		return nil, err
	}
	var result map[string]any
	err := s.Store.WithTx(ctx, func(tx *gorm.DB) error {
		var before store.GitHubSettings
		if err := tx.WithContext(ctx).Table("github_settings").Clauses(clause.Locking{Strength: "UPDATE"}).Where("id=true").Take(&before).Error; err != nil {
			return err
		}
		after := before
		if boolean(in.Body, "clearToken") {
			after.TokenCiphertext = ""
		}
		if token := text(in.Body, "token"); token != "" {
			var err error
			after.TokenCiphertext, err = s.Config.EncryptGitHubToken(token)
			if err != nil {
				return err
			}
		}
		if err := tx.WithContext(ctx).Table("github_settings").Where("id=true").Updates(map[string]any{"token_ciphertext": after.TokenCiphertext, "updated_at": s.now()}).Error; err != nil {
			return err
		}
		result = githubView(after)
		return store.Audit(ctx, tx, in.Actor, op, "github_settings", "true", githubView(before), result)
	})
	return result, store.MapAdminError(err)
}
