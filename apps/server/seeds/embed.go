package seeds

import (
	"embed"
	"fmt"

	"github.com/opennavo/opennavo/server/internal/domain"
	"go.yaml.in/yaml/v3"
)

//go:embed *.yaml
var files embed.FS

func Load() (domain.SeedData, error) {
	var data domain.SeedData
	for _, name := range []string{"categories.yaml", "rbac.yaml", "mirrors.yaml", "app_config.yaml"} {
		contents, err := files.ReadFile(name)
		if err != nil {
			return data, fmt.Errorf("read seed %s: %w", name, err)
		}
		if err := yaml.Unmarshal(contents, &data); err != nil {
			return data, fmt.Errorf("parse seed %s: %w", name, err)
		}
	}
	return data, nil
}
