package homebrew

import (
	"cmp"
	"regexp"
	"strings"
)

var versionTokens = regexp.MustCompile(`[0-9]+|[a-z]+`)

// A false bool from CompareVersion forbids inferring an update (empty values or latest).
func CompareVersion(left, right string) (int, bool) {
	left, right = strings.ToLower(strings.TrimSpace(left)), strings.ToLower(strings.TrimSpace(right))
	if left == "" || right == "" || left == "latest" || right == "latest" {
		return 0, false
	}
	leftHead := left == "head" || strings.HasPrefix(left, "head-")
	rightHead := right == "head" || strings.HasPrefix(right, "head-")
	if leftHead || rightHead {
		if leftHead == rightHead {
			return 0, true
		}
		if leftHead {
			return 1, true
		}
		return -1, true
	}
	lparts, rparts := strings.Split(strings.TrimPrefix(left, "v"), ","), strings.Split(strings.TrimPrefix(right, "v"), ",")
	for i := range max(len(lparts), len(rparts)) {
		var lpart, rpart string
		if i < len(lparts) {
			lpart = lparts[i]
		}
		if i < len(rparts) {
			rpart = rparts[i]
		}
		if result := compareTokens(versionTokens.FindAllString(lpart, -1), versionTokens.FindAllString(rpart, -1)); result != 0 {
			return result, true
		}
	}
	return 0, true
}

func splitVersion(tokens []string) ([]string, string, []string) {
	for i, token := range tokens {
		if token[0] >= 'a' && token[0] <= 'z' {
			return tokens[:i], token, tokens[i+1:]
		}
	}
	return tokens, "", nil
}

func compareTokens(left, right []string) int {
	lnums, llabel, lrest := splitVersion(left)
	rnums, rlabel, rrest := splitVersion(right)
	for i := range max(len(lnums), len(rnums)) {
		lnum, rnum := "0", "0"
		if i < len(lnums) {
			lnum = strings.TrimLeft(lnums[i], "0")
		}
		if i < len(rnums) {
			rnum = strings.TrimLeft(rnums[i], "0")
		}
		if lnum == "" {
			lnum = "0"
		}
		if rnum == "" {
			rnum = "0"
		}
		if result := cmp.Compare(len(lnum), len(rnum)); result != 0 {
			return result
		}
		if result := strings.Compare(lnum, rnum); result != 0 {
			return result
		}
	}
	lrank, lcanonical := versionLabel(llabel)
	rrank, rcanonical := versionLabel(rlabel)
	if result := cmp.Compare(lrank, rrank); result != 0 {
		return result
	}
	if result := strings.Compare(lcanonical, rcanonical); result != 0 {
		return result
	}
	if len(lrest) == 0 && len(rrest) == 0 {
		return 0
	}
	return compareTokens(lrest, rrest)
}

func versionLabel(label string) (int, string) {
	switch label {
	case "alpha", "a":
		return 0, "alpha"
	case "beta", "b":
		return 1, "beta"
	case "pre", "preview":
		return 2, "pre"
	case "rc":
		return 3, "rc"
	case "":
		return 4, ""
	case "p", "post":
		return 5, "post"
	default:
		return 6, label
	}
}
