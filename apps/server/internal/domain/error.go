package domain

import (
	"net/http"

	"github.com/opennavo/opennavo/server/internal/i18n"
)

type AppError struct {
	Code       string
	Msg        string
	HTTPStatus int
	Cause      error
}

func (e *AppError) Error() string { return e.Code + ": " + e.Msg }
func (e *AppError) Unwrap() error { return e.Cause }
func Internal(cause error) *AppError {
	return &AppError{Code: CodeInternal, HTTPStatus: http.StatusInternalServerError, Cause: cause}
}
func Validation() *AppError {
	return &AppError{Code: CodeValidation, HTTPStatus: http.StatusBadRequest}
}

func Message(code, locale string) string {
	return i18n.Message(code, locale)
}
