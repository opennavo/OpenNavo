# Client catalog sync fixtures

Rust unit tests read these files directly without APIs, databases or networking. They were generated from seed-e2e's 60 packages/22 categories: HTTP JSON uses the public handler, gzip uses production snapshot serialization, and the format version is 1. Domains are URL-format examples only; downloads are unnecessary.

| File | Content and order of use |
| --- | --- |
| catalog.json.gz | Full gzip; decompress to formatVersion/generatedAt/cursor/categories/items, cursor=60 |
| latest.json | Raw CDN snapshot metadata without response envelope; SHA256 and bytes match catalog.json.gz |
| snapshot.json | GET /catalog/snapshot with the `{code,msg,data}` envelope |
| changes-page.json | since=60/limit=3: 61 VS Code update, 62 font deletion, 63 node update; nextCursor=63, hasMore=true |
| changes-final.json | since=63: 64 WeChat update; nextCursor=64, hasMore=false |
| changes-empty.json | since=64: empty changes; nextCursor=64, hasMore=false |
| changes-expired.json | since=0 predates retained cursor 60: HTTP 410 response body, code=1201, data=null; client rereads latest and imports the snapshot |
| client-config.json | GET /config/client?platform=desktop&version=0.1.0&locale=zh-CN response |

Suggested test sequence: import snapshot, apply both delta pages, reapply the final page (idempotency), apply an empty delta, then reimport after 410. Delete entries have no item and must be removed by kind/token. Update the cursor only after the whole-page transaction commits.

Snapshots and deltas include optional downloadSize, installs90d, installs365d and onRequest (Formula installations on request over three periods), supporting update-size estimates and offline rankings. Omission in old formats means unknown; Casks have no onRequest. Three icon URLs are synthetic media examples that Rust tests do not download. client-config has latestVersion 0.3.0 and a privacy link to /about.

Generate from the repository root with `node tooling/scripts/tasks/server.mjs desktop-fixtures`. Docker is required. The generator test uses temporary PostgreSQL/Redis on random ports and in-memory object storage; it does not access the development database, start an API, execute brew or call an LLM. Time is fixed at 2026-10-01T00:00:00Z for byte-identical regeneration.

Validation: ordinary Go tests in `make test-server` check production serialization, SHA256/size and seed fields. `go test -race -tags=integration ./internal/service/e2e -run TestDesktopFixturesMatchSeedAndProductionSerialization` regenerates from a temporary seeded database and compares all files byte for byte. Regenerate after intentional sync-format or fixed-seed changes and notify client maintainers; do not delete assertions to make tests pass.
