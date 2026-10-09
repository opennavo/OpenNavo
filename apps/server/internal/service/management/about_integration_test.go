//go:build integration

package management

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/opennavo/opennavo/server/internal/about"
	"github.com/opennavo/opennavo/server/internal/jobs"
	"github.com/opennavo/opennavo/server/internal/testutil"
	"github.com/stretchr/testify/require"
)

func TestAboutConfigSaveQueuesTranslationAndRejectsUnsafeLinks(t *testing.T) {
	st := testutil.NewStore(t)
	svc := Service{Store: st}
	raw, err := os.ReadFile("../../../seeds/about.json")
	require.NoError(t, err)
	var value map[string]any
	require.NoError(t, json.Unmarshal(raw, &value))
	_, err = svc.Execute(context.Background(), "UpdateAppConfig", Input{Key: about.Key, Body: map[string]any{"value": value, "description": "about"}})
	require.NoError(t, err)
	var payload string
	require.NoError(t, st.DB.Raw("SELECT payload::text FROM job_outbox WHERE unique_key='translate:content:about:site.about'").Scan(&payload).Error)
	decoded, _, err := jobs.DecodeOutbox(json.RawMessage(payload))
	require.NoError(t, err)
	require.Equal(t, "about", decoded.Content.Entity)
	_, _, err = jobs.NewTask("translate:content", decoded)
	require.NoError(t, err)
	c, err := about.Parse(raw)
	require.NoError(t, err)
	require.Equal(t, c.SourceHash(), decoded.SourceHash)
	value["modules"].([]any)[0].(map[string]any)["url"] = "javascript:alert(1)"
	_, err = svc.Execute(context.Background(), "UpdateAppConfig", Input{Key: about.Key, Body: map[string]any{"value": value}})
	require.Error(t, err)
	var saved string
	require.NoError(t, st.DB.Raw("SELECT value::text FROM app_config WHERE key=?", about.Key).Scan(&saved).Error)
	_, err = about.Parse([]byte(saved))
	require.NoError(t, err)
}
