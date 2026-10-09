package management

import (
	"testing"

	"github.com/opennavo/opennavo/server/internal/config"
	"github.com/stretchr/testify/require"
)

func TestTranslationSettingsRejectCredentialsInURLAndBudgetOverflow(t *testing.T) {
	cfg := config.Config{AppEnv: "prod"}
	valid := map[string]any{"enabled": false, "baseUrl": "https://gateway.example/v1", "model": "unit-model", "reasoningEffort": "medium", "monthlyTokenBudget": float64(1000)}
	require.NoError(t, validateTranslationSettings(valid, cfg))
	valid["monthlyTokenBudget"] = float64(30000001)
	require.NoError(t, validateTranslationSettings(valid, cfg))
	for _, change := range []map[string]any{
		{"baseUrl": "https://" + "user:password" + "@gateway.example/v1"}, {"baseUrl": "https://gateway.example/v1?key=private"}, {"baseUrl": "http://gateway.example/v1"}, {"baseUrl": "file:///tmp"}, {"model": "bad model"}, {"reasoningEffort": "max"}, {"monthlyTokenBudget": float64(9007199254740992)}, {"monthlyTokenBudget": float64(0)}, {"monthlyTokenBudget": float64(1.5)}, {"apiKey": "unit-key", "clearApiKey": true},
	} {
		body := map[string]any{}
		for k, v := range valid {
			body[k] = v
		}
		for k, v := range change {
			body[k] = v
		}
		require.Error(t, validateTranslationSettings(body, cfg))
	}
}
