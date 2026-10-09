package config

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
)

// Separate purpose derivation and authenticated data prevent interchange with translation keys; api/worker share the environment root key.
func (c Config) githubCipher() (cipher.AEAD, error) {
	secret := c.GitHubSettingsEncryptionKey
	if secret == "" {
		secret = c.JWTSecret
	}
	if len(secret) < 32 {
		return nil, errors.New("GitHub encryption configuration missing")
	}
	derive := hmac.New(sha256.New, []byte(secret))
	_, _ = derive.Write([]byte("opennavo:github-token:v1"))
	block, err := aes.NewCipher(derive.Sum(nil))
	if err != nil {
		return nil, errors.New("GitHub encryption unavailable")
	}
	return cipher.NewGCM(block)
}

func (c Config) EncryptGitHubToken(value string) (string, error) {
	aead, err := c.githubCipher()
	if err != nil {
		return "", err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", errors.New("GitHub encryption unavailable")
	}
	return base64.StdEncoding.EncodeToString(aead.Seal(nonce, nonce, []byte(value), []byte("github_settings"))), nil
}

func (c Config) DecryptGitHubToken(value string) (string, error) {
	aead, err := c.githubCipher()
	if err != nil {
		return "", err
	}
	data, err := base64.StdEncoding.DecodeString(value)
	if err != nil || len(data) < aead.NonceSize() {
		return "", errors.New("GitHub credential unavailable")
	}
	plain, err := aead.Open(nil, data[:aead.NonceSize()], data[aead.NonceSize():], []byte("github_settings"))
	if err != nil {
		return "", errors.New("GitHub credential unavailable")
	}
	return string(plain), nil
}
