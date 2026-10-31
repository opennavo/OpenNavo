//go:build integration

package management

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/opennavo/opennavo/server/internal/domain"
	"github.com/opennavo/opennavo/server/internal/testutil"
	"github.com/stretchr/testify/require"
)

func TestLinkVersionRevisionAndSourceNormalization(t *testing.T) {
	ctx := context.Background()
	st := testutil.NewSEOStore(t)
	svc := &Service{Store: st}
	agentWrite := func(id, revision int64, dry bool, body map[string]any) (any, error) {
		op := &domain.Operation{RequestID: uuid.NewString(), AgentClientID: 1, AgentTokenID: 2,
			Permissions: []string{"catalog:package:edit"}, RequiredPermissions: []string{"catalog:package:edit"}, DryRun: dry,
			Execution: &domain.AgentExecution{ExpectedRevisionSet: true, ExpectedRevision: revision}}
		return svc.Execute(domain.WithOperation(ctx, op), "UpdateLinkPackage", Input{ID: id, Body: body})
	}
	revision := func(id int64) int64 {
		t.Helper()
		app, err := st.LinkApp(ctx, id)
		require.NoError(t, err)
		return app.Revision
	}

	created, err := svc.Execute(ctx, "AddLinkPackage", Input{Body: map[string]any{"token": "ver-board", "name": "Ver Board", "homepage": "https://vendor.example.test"}})
	require.NoError(t, err)
	id := valueID(created.(map[string]any)["id"])
	before := revision(id)
	_, err = agentWrite(id, before, false, map[string]any{"version": "1.0.7"})
	require.NoError(t, err)
	require.Equal(t, before+1, revision(id), "a version-only write advances the revision")
	_, err = agentWrite(id, before, false, map[string]any{"version": "1.0.8"})
	var conflict *domain.AppError
	require.ErrorAs(t, err, &conflict)
	require.Equal(t, domain.CodeConflict, conflict.Code)
	app, err := st.LinkApp(ctx, id)
	require.NoError(t, err)
	require.Equal(t, "1.0.7", *app.Version, "a stale revision cannot overwrite the version")

	// A dry run that omits version previews the preserved version instead of dropping it.
	dry, err := svc.Execute(ctx, "UpdateLinkPackage", Input{ID: id, Body: map[string]any{"name": "Renamed"}, Params: map[string]any{"dryrun": true}})
	require.NoError(t, err)
	after := dry.(map[string]any)["changes"].([]any)[0].(map[string]any)["after"].(domain.LinkInput)
	require.NotNil(t, after.Version)
	require.Equal(t, "1.0.7", *after.Version)

	// A sourced link: clearing githubRepo while writing a version behaves the same in dry run and write.
	created, err = svc.Execute(ctx, "AddLinkPackage", Input{Body: map[string]any{"token": "ver-sourced", "name": "Ver Sourced", "homepage": "https://vendor.example.test", "githubRepo": "owner/sourced"}})
	require.NoError(t, err)
	id = valueID(created.(map[string]any)["id"])
	body := map[string]any{"githubRepo": "", "version": "1.0.7"}
	_, err = svc.Execute(ctx, "UpdateLinkPackage", Input{ID: id, Body: body, Params: map[string]any{"dryrun": true}})
	require.NoError(t, err)
	_, err = svc.Execute(ctx, "UpdateLinkPackage", Input{ID: id, Body: body})
	require.NoError(t, err)
	app, err = st.LinkApp(ctx, id)
	require.NoError(t, err)
	require.Nil(t, app.GithubRepo)
	require.Equal(t, "1.0.7", *app.Version)
	// And a version on a still-sourced link is rejected identically in both paths.
	_, err = svc.Execute(ctx, "UpdateLinkPackage", Input{ID: id, Body: map[string]any{"githubRepo": "owner/sourced"}})
	require.NoError(t, err)
	for _, dry := range []bool{true, false} {
		_, err = svc.Execute(ctx, "UpdateLinkPackage", Input{ID: id, Body: map[string]any{"version": "2.0"}, Params: map[string]any{"dryrun": dry}})
		require.ErrorContains(t, err, "version_managed_by_source", "dryrun=%v", dry)
	}
}
