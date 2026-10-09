package storage

import (
	"encoding/json"
	"slices"
	"testing"
)

func TestAnonymousPolicyAllowsOnlyTheFourReadPrefixes(t *testing.T) {
	encoded, err := PublicPolicy("opennavo")
	if err != nil {
		t.Fatal(err)
	}
	var policy struct {
		Statement []struct {
			Action   []string
			Resource []string
		}
	}
	if err := json.Unmarshal([]byte(encoded), &policy); err != nil {
		t.Fatal(err)
	}
	if len(policy.Statement) != 1 || len(policy.Statement[0].Action) != 1 || policy.Statement[0].Action[0] != "s3:GetObject" {
		t.Fatal("anonymous policy must never grant write or list access")
	}
	resources := policy.Statement[0].Resource
	if len(resources) != 4 {
		t.Fatal("unexpected public-prefix count")
	}
	for _, prefix := range []string{"icons/", "screenshots/", "snapshots/", "desktop/"} {
		if !slices.Contains(resources, "arn:aws:s3:::opennavo/"+prefix+"*") {
			t.Fatalf("missing prefix %s", prefix)
		}
	}
	if slices.Contains(resources, "arn:aws:s3:::opennavo/*") {
		t.Fatal("private keys are publicly readable")
	}
}
