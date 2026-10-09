package management

import (
	"context"
	"testing"

	"github.com/opennavo/opennavo/server/internal/domain"
	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/stretchr/testify/require"
)

func TestRestorePermissionRequiresCurrentAgentObjectAccess(t *testing.T) {
	actorID, otherActorID := int64(1), int64(2)
	for _, entity := range []string{"package", "release", "category", "collection", "collection_item", "feature", "screenshot", "desktop_release", "announcement"} {
		t.Run(entity, func(t *testing.T) {
			op := &domain.Operation{AgentClientID: 1, ActorID: &actorID, Permissions: []string{"content:revision:restore", "translation:review"}}
			ctx := domain.WithOperation(context.Background(), op)
			assertForbidden := func(err error) {
				t.Helper()
				var appError *domain.AppError
				require.ErrorAs(t, err, &appError)
				require.Equal(t, domain.CodeForbidden, appError.Code)
			}
			assertForbidden(restorePermission(ctx, entity, []string{"translation:review"}, &actorID))
			op.Permissions = append(op.Permissions, entityPermission(entity))
			require.NoError(t, restorePermission(ctx, entity, []string{"translation:review"}, &actorID))
			assertForbidden(restorePermission(ctx, entity, []string{"translation:review"}, &otherActorID))
			assertForbidden(restorePermission(ctx, entity, []string{"translation:review"}, nil))
			assertForbidden(restorePermission(ctx, entity, []string{"system:config:edit"}, &actorID))
		})
	}
}

func TestRestoreDeletionGuardIncludesClearedEditorialAndIcon(t *testing.T) {
	icon := store.HistoryState{"package_meta": {{"package_id": 1, "icon_asset_id": 2}}}
	noIcon := store.HistoryState{"package_meta": {{"package_id": 1, "icon_asset_id": nil}}}
	require.True(t, restoresDeletedContent("package", icon, noIcon))
	require.False(t, restoresDeletedContent("package", noIcon, icon))
	require.True(t, restoresDeletedContent("release", nil, store.HistoryState{"releases": {{"source": "editorial", "hidden": true}}}))
	require.False(t, restoresDeletedContent("release", nil, store.HistoryState{"releases": {{"source": "editorial", "hidden": false}}}))
	require.True(t, restoresDeletedContent("collection", nil, nil))
}
