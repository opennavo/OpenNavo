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

// api and worker share the environment key; purpose derivation avoids directly reusing the JWT signing key.
func (c Config) translationCipher() (cipher.AEAD, error) {
	secret := c.LLMSettingsEncryptionKey
	if secret == "" {
		secret = c.JWTSecret
	}
	if len(secret) < 32 {
		return nil, errors.New("translation encryption configuration missing")
	}
	derive := hmac.New(sha256.New, []byte(secret))
	_, _ = derive.Write([]byte("opennavo:translation-key:v1"))
	block, err := aes.NewCipher(derive.Sum(nil))
	if err != nil {
		return nil, errors.New("translation encryption unavailable")
	}
	return cipher.NewGCM(block)
}
func (c Config) EncryptTranslationKey(value string) (string, error) {
	aead, err := c.translationCipher()
	if err != nil {
		return "", err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", errors.New("translation encryption unavailable")
	}
	return base64.StdEncoding.EncodeToString(aead.Seal(nonce, nonce, []byte(value), []byte("i18n_settings"))), nil
}
func (c Config) DecryptTranslationKey(value string) (string, error) {
	aead, err := c.translationCipher()
	if err != nil {
		return "", err
	}
	data, err := base64.StdEncoding.DecodeString(value)
	if err != nil || len(data) < aead.NonceSize() {
		return "", errors.New("translation credential unavailable")
	}
	plain, err := aead.Open(nil, data[:aead.NonceSize()], data[aead.NonceSize():], []byte("i18n_settings"))
	if err != nil {
		return "", errors.New("translation credential unavailable")
	}
	return string(plain), nil
}
