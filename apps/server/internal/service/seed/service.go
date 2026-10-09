package seed

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/opennavo/opennavo/server/internal/config"
	"github.com/opennavo/opennavo/server/internal/domain"
	"github.com/opennavo/opennavo/server/seeds"
	"golang.org/x/crypto/argon2"
)

type Repository interface {
	AdminExists(context.Context, string) (bool, error)
	Seed(context.Context, domain.SeedData, string, string) error
}

func Run(ctx context.Context, repo Repository, cfg config.Config) error {
	data, err := seeds.Load()
	if err != nil {
		return err
	}
	if cfg.WebBaseURL != "" {
		value, err := json.Marshal(strings.TrimRight(cfg.WebBaseURL, "/") + "/download")
		if err != nil {
			return fmt.Errorf("encode initial download URL: %w", err)
		}
		for index := range data.Configs {
			if data.Configs[index].Key == "web.downloadUrl" {
				// Store inserts missing keys only and never overwrites configuration already edited in the admin UI.
				data.Configs[index].Value = string(value)
			}
		}
	}
	exists, err := repo.AdminExists(ctx, cfg.AdminBootstrapUsername)
	if err != nil {
		return fmt.Errorf("check bootstrap admin: %w", err)
	}
	hash := ""
	if !exists {
		if cfg.AdminBootstrapUsername == "" || len(cfg.AdminBootstrapPassword) < 10 {
			return errors.New("ADMIN_BOOTSTRAP_USERNAME and ADMIN_BOOTSTRAP_PASSWORD (at least 10 characters) are required for first seed")
		}
		hash, err = HashPassword(cfg.AdminBootstrapPassword)
		if err != nil {
			return err
		}
	}
	return repo.Seed(ctx, data, cfg.AdminBootstrapUsername, hash)
}
func HashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate password salt: %w", err)
	}
	encoded := base64.RawStdEncoding
	hash := argon2.IDKey([]byte(password), salt, 3, 64*1024, 2, 32)
	return fmt.Sprintf("$argon2id$v=19$m=65536,t=3,p=2$%s$%s", encoded.EncodeToString(salt), encoded.EncodeToString(hash)), nil
}
