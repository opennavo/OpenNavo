//go:build integration

package management

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/opennavo/opennavo/server/internal/content"
	"github.com/opennavo/opennavo/server/internal/domain"
	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/opennavo/opennavo/server/internal/testutil"
	"github.com/stretchr/testify/require"
)

func TestHistoryDateFilters(t *testing.T) {
	ctx := context.Background()
	st := testutil.NewStore(t)
	svc := &Service{Store: st}
	for id := int64(1); id <= 3; id++ {
		op := &domain.Operation{RequestID: uuid.NewString(), Name: "deleteGlossaryTerm", RequiredPermissions: []string{"content:glossary:edit"}}
		_, err := st.RecordRevision(ctx, content.Ref{Entity: "glossary", ID: id}, store.HistoryState{"i18n_glossary": {{"id": id}}}, nil, "delete", op)
		require.NoError(t, err)
	}
	// Deliberately separate revision and deletion timestamps by one day so trash cannot mistakenly use revision timestamps.
	require.NoError(t, st.DB.Exec("UPDATE content_revisions SET created_at='2001-01-01T00:00:00Z'::timestamptz + (object_key::integer-1)*interval '1 day'").Error)
	require.NoError(t, st.DB.Exec("UPDATE content_trash SET deleted_at='2001-02-01T00:00:00Z'::timestamptz + (object_key::integer-1)*interval '1 day'").Error)
	for _, history := range []struct{ operation, month string }{{"ListContentRevisions", "01"}, {"ListTrash", "02"}} {
		t.Run(history.operation, func(t *testing.T) {
			start := "2001-" + history.month + "-02T00:00:00Z"
			end := "2001-" + history.month + "-03T00:00:00Z"
			for _, tc := range []struct {
				name, from, to string
				keys           []string
			}{
				{"no bounds", "", "", []string{"3", "2", "1"}},
				{"from inclusive", start, "", []string{"3", "2"}},
				{"to exclusive", "", start, []string{"1"}},
				{"both bounds", start, end, []string{"2"}},
				{"equal bounds", start, start, []string{}},
				{"ancient range", "2000-01-01T00:00:00Z", "2000-12-31T00:00:00Z", []string{}},
				{"timezone offset", "2001-" + history.month + "-02T08:00:00+08:00", end, []string{"2"}},
			} {
				t.Run(tc.name, func(t *testing.T) {
					result, err := svc.Execute(ctx, history.operation, Input{Params: map[string]any{"from": tc.from, "to": tc.to}})
					require.NoError(t, err)
					page := result.(store.AdminPage)
					require.Equal(t, int64(len(tc.keys)), page.Total)
					keys := []string{}
					for _, raw := range page.Records {
						var record struct{ Object struct{ ObjectKey string } }
						require.NoError(t, json.Unmarshal(raw, &record))
						keys = append(keys, record.Object.ObjectKey)
					}
					require.Equal(t, tc.keys, keys)
				})
			}
			result, err := svc.Execute(ctx, history.operation, Input{Params: map[string]any{"from": start, "current": float64(2), "size": float64(1)}})
			require.NoError(t, err)
			page := result.(store.AdminPage)
			require.EqualValues(t, 2, page.Total)
			require.Len(t, page.Records, 1)
			require.Contains(t, string(page.Records[0]), `"objectKey": "2"`)
		})
	}
}

func TestHistoryActorFilterIntersectsAgentScope(t *testing.T) {
	ctx := context.Background()
	st := testutil.NewStore(t)
	require.NoError(t, st.DB.Exec("INSERT INTO admin_users(id,user_name,password_hash) VALUES(1,'first','isolated-test'),(2,'second','isolated-test')").Error)
	svc := &Service{Store: st}
	for _, actorID := range []int64{1, 2, 1} {
		op := &domain.Operation{RequestID: uuid.NewString(), Name: "upsertGlossaryTerm", ActorID: &actorID, RequiredPermissions: []string{"content:glossary:edit"}}
		_, err := st.RecordRevision(ctx, content.Ref{Entity: "glossary", ID: actorID}, nil, store.HistoryState{"i18n_glossary": {{"id": actorID}}}, "create", op)
		require.NoError(t, err)
	}
	actorID := int64(1)
	agentCtx := domain.WithOperation(ctx, &domain.Operation{AgentClientID: 1, ActorID: &actorID, Permissions: []string{"agent:log:view", "content:glossary:edit"}})
	for _, tc := range []struct {
		name    string
		ctx     context.Context
		actorID float64
		total   int64
	}{
		{"admin selects first", ctx, 1, 2},
		{"admin selects second", ctx, 2, 1},
		{"unknown actor", ctx, 999999, 0},
		{"agent selects itself", agentCtx, 1, 2},
		{"agent selects another actor", agentCtx, 2, 0},
		{"agent selects unknown actor", agentCtx, 999999, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result, err := svc.Execute(tc.ctx, "ListContentRevisions", Input{Params: map[string]any{"actorid": tc.actorID, "size": float64(1)}})
			require.NoError(t, err)
			page := result.(store.AdminPage)
			require.Equal(t, tc.total, page.Total)
			if tc.total == 0 {
				require.Empty(t, page.Records)
			} else {
				require.Len(t, page.Records, 1)
				var record struct{ Actor struct{ ID int64 } }
				require.NoError(t, json.Unmarshal(page.Records[0], &record))
				require.EqualValues(t, tc.actorID, record.Actor.ID)
			}
		})
	}
}
