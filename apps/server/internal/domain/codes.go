package domain

const (
	CodeOK                  = "0000"
	CodeValidation          = "1001"
	CodeNotFound            = "1002"
	CodeConflict            = "1003"
	CodeForbidden           = "1004"
	CodeRateLimited         = "1005"
	CodeInvalidState        = "1006"
	CodeInvalidUpload       = "1007"
	CodeInvalidCredentials  = "1101"
	CodeAccountLocked       = "1102"
	CodeCursorExpired       = "1201"
	CodeUpstreamUnavailable = "1301"
	CodeLLMUnavailable      = "1302"
	CodeInternal            = "5000"
	CodeSessionInvalid      = "7777"
	CodePasswordChanged     = "7778"
	CodeUnauthenticated     = "8888"
	CodeAccountDisabled     = "8889"
	CodeAccessExpired       = "9999"
)
