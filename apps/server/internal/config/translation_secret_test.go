package config

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestTranslationCredentialAuthenticatedEncryption(t *testing.T) {
	cfg := Config{JWTSecret: strings.Repeat("a", 32)}
	first, err := cfg.EncryptTranslationKey("unit-credential")
	require.NoError(t, err)
	second, err := cfg.EncryptTranslationKey("unit-credential")
	require.NoError(t, err)
	require.NotEqual(t, first, second)
	require.NotContains(t, first, "unit-credential")
	plain, err := cfg.DecryptTranslationKey(first)
	require.NoError(t, err)
	require.Equal(t, "unit-credential", plain)
	_, err = (Config{JWTSecret: strings.Repeat("b", 32)}).DecryptTranslationKey(first)
	require.Error(t, err)
	_, err = cfg.DecryptTranslationKey(first[:len(first)-4] + "AAAA")
	require.Error(t, err)
	require.NotContains(t, err.Error(), "unit-credential")
	dedicated := Config{JWTSecret: strings.Repeat("b", 32), LLMSettingsEncryptionKey: strings.Repeat("c", 32)}
	encrypted, err := dedicated.EncryptTranslationKey("dedicated-credential")
	require.NoError(t, err)
	dedicated.JWTSecret = strings.Repeat("d", 32)
	plain, err = dedicated.DecryptTranslationKey(encrypted)
	require.NoError(t, err)
	require.Equal(t, "dedicated-credential", plain)
}
