# Cloudflare free-tier migration

This directory documents the optional free-tier Cloudflare pieces. Nothing here is enabled by
default, and the SSH deployment still manages the origin containers.

| Piece | Free tier | Effect |
|---|---|---|
| R2 public/private buckets | 10 GB-month, 1M Class A, 10M Class B, free egress | Replaces MinIO and its data volume |
| Pages admin | 500 builds/month, 20k files, 25 MiB/file, static requests unmetered | Hosts the static admin bundle |
| Pages Functions proxy | Counts toward Workers: 100k requests/day | Proxies `/admin-api/*` to the API |
| Tunnel | Available on all plans | Removes public origin ports |
| Access | Free up to 50 users | Protects admin and private endpoints |

Use placeholders in this repository. Real account IDs, API tokens, bucket names and hostnames
belong in the deployment environment or the Cloudflare dashboard.

## 1. R2 object storage

### Buckets

Create two R2 buckets:

- `opennavo-public`: `icons/`, `screenshots/`, `snapshots/`, `desktop/`
- `opennavo-private`: `backups/postgres/...` and any other non-public object

R2 public access is **bucket-wide** through a Custom Domain or `r2.dev`; it cannot be limited to
the four prefixes used by the MinIO bucket policy. Never put `backups/` in the public bucket.
Attach the Custom Domain (for example `cdn.<WEB_DOMAIN>`) only to `opennavo-public`; leave the
private bucket without public access.

Create an R2 API token with Object Read & Write on both buckets. The S3 endpoint is
`<ACCOUNT_ID>.r2.cloudflarestorage.com`.

### Environment

```dotenv
S3_ENDPOINT=<ACCOUNT_ID>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=opennavo-public
S3_PRIVATE_BUCKET=opennavo-private
S3_PUBLIC_ACCESS=custom-domain
S3_MANAGE_BUCKETS=false
S3_USE_SSL=true
S3_ACCESS_KEY=<R2_ACCESS_KEY_ID>
S3_SECRET_KEY=<R2_SECRET_ACCESS_KEY>
CDN_BASE_URL=https://cdn.<WEB_DOMAIN>
```

`S3_MANAGE_BUCKETS=false` makes `storage-init` verify both buckets instead of creating them.
`S3_PUBLIC_ACCESS=custom-domain` skips the MinIO bucket policy and is rejected unless
`S3_PRIVATE_BUCKET` is set to a different bucket. The application routes public assets and the
desktop release objects to `S3_BUCKET`; database backups use `S3_PRIVATE_BUCKET`.

Clear `CDN_BASE_URL_INTERNAL`: it points at the MinIO container hostname and has no R2
equivalent. The web container then reads share icons through `CDN_BASE_URL`.

Run the existing bootstrap after switching:

```sh
docker compose -f ops/docker-compose.prod.yml --profile ops run --rm storage-init
```

### Migration

1. Copy the existing objects into the new buckets. A mirror tool such as `rclone` or `mc` is
   enough; preserve key names exactly because URLs are stored in the database.
2. Verify representative `icons/`, `screenshots/`, `snapshots/` and `desktop/` URLs through the
   R2 Custom Domain before switching the application.
3. Keep the MinIO volume and the old `S3_*` values for rollback until the next release is stable.
4. R2 free egress covers desktop downloads; watch the 10 GB storage and Class A/B operation
   limits. Add a lifecycle rule to the private bucket if backups use more than the free quota.

The SSH receiver's pre-migration dump is separate from this bucket: it stays in the release
snapshot on the host. `S3_PRIVATE_BUCKET` is for the optional backup service that reads
`MIGRATION_DATABASE_URL`; enabling that service is a separate operational decision.

## 2. Admin on Cloudflare Pages

The admin app already builds with `VITE_SERVICE_BASE_URL=/admin-api`, so it keeps the same
origin when hosted on Pages. `apps/admin/functions/admin-api/[[path]].js` and
`apps/admin/functions/oauth/[[path]].js` proxy those requests to `ADMIN_API_ORIGIN`;
`apps/admin/public/_redirects` provides the SPA fallback, and `apps/admin/public/_headers` adds
basic browser hardening. The OAuth protocol endpoints live outside `/admin-api`, so both paths
must stay proxied.

### Setup

1. Create a Pages project named `opennavo-admin`.
2. Set the Pages variable `ADMIN_API_ORIGIN` to the public API origin (for example
   `https://api.<WEB_DOMAIN>`). `apps/admin/wrangler.toml` carries the default; override it in
   the dashboard if the domain differs.
3. Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` to the `production` GitHub
   environment. The token needs Pages edit permission for this account.
4. Run the manual `Deploy admin to Cloudflare Pages` workflow. It builds the admin bundle,
   copies the third-party legal files and deploys `apps/admin/dist`.
5. Add `admin.<WEB_DOMAIN>` as the Pages Custom Domain and point DNS at Pages.
6. Verify login, dashboard and a write action. Keep the origin admin container until the Pages
   deployment is stable; the SSH receiver still deploys it in this phase.

Preview deployments use a different `*.pages.dev` origin. The API's `ADMIN_ORIGIN` and CORS
allowlist will reject that origin unless it is added explicitly; test login on the production
custom domain, or add the preview origin only for a temporary review.

The admin uses Bearer tokens from browser storage, not cookies, so the same-origin Pages
Function proxy needs no cookie or CORS changes. Pages Functions share the Workers free quota of
100,000 requests/day; admin traffic is low, but monitor it.

After cutover, verify admin audit logs and rate limits. The Function is a server-side subrequest
through Cloudflare to `api.<WEB_DOMAIN>`; confirm the API still receives the expected client IP
and that WAF/rate rules do not challenge `/admin-api/*` from the Pages Function. Add an allow
rule scoped to the admin API path if the existing rules block it.

## 3. Cloudflare Tunnel and Access

### Tunnel

`tunnel.example.yml` is an ingress example. Create the tunnel and DNS routes with the dashboard
or:

```sh
cloudflared tunnel create opennavo
cloudflared tunnel route dns opennavo <WEB_DOMAIN>
cloudflared tunnel route dns opennavo www.<WEB_DOMAIN>
cloudflared tunnel route dns opennavo api.<WEB_DOMAIN>
cloudflared tunnel run opennavo
```

The ingress can target the existing host nginx or Caddy directly. If it targets Caddy on
`127.0.0.1:18088`, the host nginx can be retired after validation.

Tunnel changes the peer address Caddy sees. Before enabling it:

- Add the local cloudflared hop to `TRUSTED_PROXIES`, `NUXT_TRUSTED_PROXIES`,
  `OPENNAVO_MCP_TRUSTED_PROXIES` and `USAGE_COUNTRY_TRUSTED_PROXIES` as appropriate.
- Keep `OPENNAVO_CF_VERIFIED_BOT_ENABLED=false` until the new ingress is verified end to end;
  the verified-bot rules check both the forwarding chain and the Cloudflare CIDRs.
- Confirm client IPs, rate limits and country attribution through the API and web logs without
  logging raw addresses.
- Close public 80/443 only after the tunnel is serving all hostnames.

### Access

Create a Zero Trust Access application for `admin.<WEB_DOMAIN>` and allow only the operators'
identities. The free Zero Trust plan covers up to 50 users.

Do not put the public MCP endpoint behind Access. Private automation should use Access service
tokens; desktop and agent clients that cannot complete browser SSO must keep the existing
application authentication path. Access is an additional layer, not a replacement for
`ADMIN_ORIGIN`, admin sessions or API authorization.

## 4. Deliberately not moved

- PostgreSQL stays on PostgreSQL; D1 is SQLite and the free database limit is far below the
  current multi-gigabyte database.
- Redis stays on Redis; KV limits and eventual consistency are not suitable for page caches,
  rate limits or Asynq queues.
- The Go API, worker, Nuxt SSR web and Python MCP servers stay on the origin. Workers free CPU
  and request limits are too low for their current traffic and runtime.
- Prometheus and its application metrics stay on the origin; Cloudflare Analytics is not a
  replacement for application metrics and alerts.
