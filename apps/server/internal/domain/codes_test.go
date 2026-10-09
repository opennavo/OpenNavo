package domain

import (
	"errors"
	"io/fs"
	"os"
	"regexp"
	"slices"
	"testing"

	"github.com/opennavo/opennavo/server/gen/adminapi"
)

var allCodes = []string{CodeOK, CodeValidation, CodeNotFound, CodeConflict, CodeForbidden, CodeRateLimited, CodeInvalidState, CodeInvalidUpload, CodeInvalidCredentials, CodeAccountLocked, CodeCursorExpired, CodeUpstreamUnavailable, CodeLLMUnavailable, CodeInternal, CodeSessionInvalid, CodePasswordChanged, CodeUnauthenticated, CodeAccountDisabled, CodeAccessExpired}

func TestCodesMatchDocumentation(t *testing.T) {
	document, err := os.ReadFile("../../../../docs/04-api.md")
	if errors.Is(err, fs.ErrNotExist) {
		// Development docs are not shipped in the public repository; compare the section 3 error-code table only when docs exist locally.
		t.Skip("docs/04-api.md is not part of the public repository")
	}
	if err != nil {
		t.Fatal(err)
	}
	matches := regexp.MustCompile("(?m)^\\| `([0-9]{4})` ").FindAllStringSubmatch(string(document), -1)
	if len(matches) != len(allCodes) {
		t.Fatal("Go codes and documented code counts differ")
	}
	for _, match := range matches {
		if !slices.Contains(allCodes, match[1]) {
			t.Fatalf("Go code missing %s", match[1])
		}
	}
}

func TestCodesMatchAdminErrorSchema(t *testing.T) {
	spec, err := adminapi.GetSpec()
	if err != nil {
		t.Fatal(err)
	}
	errorCodes := spec.Components.Schemas["BusinessErrorResponse"].Value.Properties["code"].Value.Enum
	if len(errorCodes) != len(allCodes)-1 {
		t.Fatal("admin error schema code count differs")
	}
	for _, code := range allCodes {
		if code != CodeOK && !slices.Contains(errorCodes, any(code)) {
			t.Fatalf("admin error schema missing %s", code)
		}
		for _, locale := range []string{"zh-CN", "en-US"} {
			if Message(code, locale) == "" {
				t.Fatalf("missing message %s/%s", code, locale)
			}
		}
	}
	if slices.Contains(errorCodes, any(CodeOK)) {
		t.Fatal("business-error schema accepts success code")
	}
}
