# Dependency security review — 2026-10-09

This is a local recheck and remediation record for the checkout based on `ad56bcb`. It is not a claim that GitHub Actions passed or that the hosted deployment has been upgraded. No vulnerability exclusions were added. Image counts are matching package/advisory records, including repeated CVEs in different binaries, not counts of exploitable application endpoints.

## GitHub release gate follow-up

The first complete backend CI reached `govulncheck` after integration tests passed
and reported nine reachable advisories in Go 1.27.1 / `golang.org/x/net` v0.59.0.
The application now pins Go 1.27.2 and x/net v0.60.0, including the server image
build toolchain. The patched local symbol scan reports no vulnerable called
symbols or imported packages; one unused module-level advisory remains. The
older image scan counts below are historical and do not describe this new image.
Dependency notices were regenerated using the server module's selected toolchain.

## Node dependencies

| Audit scope | Before: critical / high / moderate / low | After |
|---|---|---|
| `pnpm audit --prod` | 0 / 4 / 4 / 1 | **0 / 2 / 0 / 0** |
| `pnpm audit` (including development tools) | 2 / 13 / 10 / 3 | **0 / 5 / 1 / 0** |

Changes:

- Upgrade affected transitive versions of tinypool, lodash, tmp, uuid, basic-ftp, and esbuild through scoped overrides. `uuid` 11 retains CommonJS support for legacy tool callers; application builds, the formatter, and a Prism mock response were checked.
- Remove `vite-plugin-svg-icons` and its legacy svg-baker/PostCSS 5 dependency tree. Local admin icons now use the existing unplugin-icons Vue compiler. Tests cover every local SVG, fallback names, and inherited object-property names.
- Retain the previous targeted axios, nanoid, echarts, colord, qs, micromatch, fflate, and simple-git fixes. Regenerate locked dependency evidence and distribution notices.
- Add a full-scope npm audit to security CI with a critical-severity failure threshold. Lower-severity findings remain visible and tracked here; this gate does not mean zero vulnerabilities.

Remaining Node findings:

| Package | Scope and disposition |
|---|---|
| node-forge 1.4.0 | High, `@nuxtjs/seo → nuxt-og-image → nitropack → listhen`; development HTTPS certificate tooling. No patched upstream release for [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv). Not present in the rebuilt Nitro runtime dependency manifests. |
| braces 3.0.3 | High, file-globbing/build tooling; no patched upstream release for [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). Do not accept untrusted glob patterns. Not present in rebuilt Nitro runtime dependency manifests. |
| extract-zip 2.0.1 | Two high advisories, Lighthouse/Puppeteer tooling: [symlink escape](https://github.com/advisories/GHSA-jmr9-qjv8-65gv) and [write through a symlink](https://github.com/advisories/GHSA-7pqw-9j4j-h8q3). No patched published release. Do not use this toolchain to extract untrusted archives. |
| @faker-js/faker 5.5.3 | High, Prism → postman-collection. Upstream's fix is in the modern major; replacing it directly breaks the legacy `locale/en` and method APIs. A compatible upstream migration is still required. Do not expose Prism to untrusted clients or schemas. |
| sprintf-js 1.0.3 | Moderate, Prism's legacy schema tooling. No patched published release for unbounded precision specifiers; only trusted local specifications should be used. |

These remaining tooling issues have not been proved exploitable through the production application. Conversely, absence of a package manifest alone cannot rule out code embedded in a bundle. Keep build/test jobs isolated from production credentials and do not describe this audit as clean.

## Application and service images

Trivy 0.75.0 was run against rebuilt Linux arm64 application images and the specified third-party service tags. Upstream tags can move; retain image IDs/digests with release evidence and recheck the exact deployment architecture. The `--pull --no-cache` commands in the deployment guide refresh both base images and OS package updates.

| Image | Before: critical / high | After: critical / high | Remaining result |
|---|---|---|---|
| Go server | 0 / 0 | **0 / 0** | Nine unrated records: tzdata and repeated module-only OpenPGP notices across binaries. |
| Web | 1 / 13 | **0 / 0** | No findings. Runtime npm/corepack/yarn were removed; available Alpine fixes installed. |
| MCP | 0 / 48 | **0 / 0** | No findings. Alpine runtime with frozen application venv, available OS fixes, and no runtime pip. |
| Backup/ops | 14 / 114 | **0 / 0** | One unrated module notice. PostgreSQL 18 client tools replace the complete database-server base. |
| Asynqmon | 4 / 55 | **0 / 0** | One unrated tzdata notice. Rebuilt v0.7.1 UI/server with Go 1.27.1 and patched client_golang, x/sys, protobuf. |
| Optional PostgreSQL | 14 / 114 (local previous image) | **1 / 61** | Also 99 moderate, 132 low, 6 unrated. Available Debian fixes and a rebuilt gosu remove the old Go runtime findings. Debian/data-layout compatibility is retained. |
| Redis | 0 / 48 | **0 / 0** | No findings. Alpine service image with available OS fixes applied. |
| Caddy | 0 / 0 | **0 / 0** | One unrated Go module notice; the moderate zlib finding was removed by OS updates. |
| Prometheus | 0 / 2 | **0 / 0** | Upgraded to v3.15.0; two unrated OpenPGP module notices. |
| Grafana | 0 / 8 | **0 / 8** | v13.2.3 is still the latest release checked. Bundled gRPC/Tempo findings remain; 5 moderate, 3 low, 5 unrated also remain. |

PostgreSQL's remaining critical record is **CVE-2026-6653 in libxml2**, with no fixed Debian package reported by this scan. Do not silently switch existing database volumes between Debian and Alpine to change scanner counts: libc/collation changes need a separate migration plan. Keep the database private, retain backups, and review this risk before enabling the optional local database profile. Production Compose publishes no PostgreSQL port.

Grafana and the monitor remain optional and bound to loopback. Do not expose monitoring endpoints directly to the public internet. This isolation reduces exposure but does not fix the remaining upstream packages.

The custom PostgreSQL, Asynqmon, Redis, and Caddy images now have build/release targets, image variables in `ops/.env.example`, and self-hosting/verification wiring. Rebuilt third-party Go components retain their own license files and modified module manifests inside the images.

## MinIO: dependency repairs do not fix the archived server

The pinned upstream remains `RELEASE.2025-10-15T17-29-55Z` (commit `9e49d5e7a648`). Its repository is archived. The local-development build now uses the reviewed `apps/server/upstream/minio/go.mod` and `go.sum` to upgrade vulnerable transitive dependencies; the upstream server source is unchanged. The image retains the server source, modified manifests, and collected license texts under `/usr/share/doc/minio/`.

After rebuilding with the final lock, Trivy reports only two unrated records (tzdata and x/crypto); the previously detected transitive dependencies have no remaining rated findings. S3 bucket/object create/read/delete passed in isolated temporary storage. This does **not** clear the upstream server itself.

**The six server-source advisories from the original scan remain unresolved**: CVE-2026-33322 and CVE-2026-33419 (critical), and CVE-2026-34204, CVE-2026-39414, CVE-2026-40344, CVE-2026-41145 (high). Rebuilding from modified module manifests gives the main binary a `(devel)` module version; a lower scanner count must not be interpreted as fixing these upstream CVEs. In particular, unsigned-trailer upload/signature issues remain relevant even without enabling LDAP/OIDC.

MinIO is used only by local development/verification Compose files, with host ports bound to loopback. Production Compose uses separately provisioned S3-compatible storage. Do not promote this development image to a public or production object store. Replacing the archived server requires a separately validated storage/data migration, not a blind image substitution.

## Other ecosystems

- Go `govulncheck` 1.8.0, on host and Linux amd64 target: no vulnerable imported package or called symbol. There is one module-only GO-2026-5932 notice for `golang.org/x/crypto/openpgp`; the application's import graph does not include OpenPGP. The module is still needed for other cryptographic packages.
- Python `pip-audit`: zero known vulnerabilities across 65 locked production dependencies and 86 dependencies including development. This alone does not audit OS packages or pip's vendored libraries, which is why images were checked separately.
- Rust `cargo audit` 0.22.2: zero vulnerability-list entries across 633 locked dependencies; `paste` and `proc-macro-error` remain unmaintained, and `glib` retains RUSTSEC-2024-0429. `cargo tree` confirms glib is absent from the macOS aarch64 target and present in the Linux GTK graph. No Linux desktop release clearance is implied.

## Verification and rechecking

Verified locally: frozen pnpm installation; web, admin, and desktop unit tests; web/admin/desktop frontend production builds and admin type checking/lint; all local icon compilation/fallback tests; deployment configuration and 31 ops tests; license inventory regression tests and notice gates; worktree secret scan; Prism mock HTTP response; rebuilt image startup/health checks; PostgreSQL initialization and synthetic dump/restore; monitor UI/queue API; and MinIO bucket/object round-trip in isolated temporary storage.

No real database, production service, GitHub visibility, or deployment was changed. GitHub CI remains separate from these local results. A successful build or scanner pass is not a penetration test.

```sh
pnpm audit --prod --json
pnpm audit --json
node tooling/scripts/check-secrets.mjs --history
python3 -I tooling/scripts/check-notices.py
# apps/server/: govulncheck -json ./...
# apps/mcp/: uv export --frozen --no-dev --no-emit-project -o /tmp/mcp-requirements.txt
# pip-audit -r /tmp/mcp-requirements.txt
# apps/desktop/src-tauri/: cargo audit --json
# Scan each exact built image, preserving all severities:
# trivy image --scanners vuln --format json IMAGE
```

Preserve full JSON reports, scanner database timestamps, lock hashes, image identities, and test logs with release evidence. Report newly reachable issues through [SECURITY.md](../../.github/SECURITY.md). See [THIRD_PARTY.md](../legal/THIRD_PARTY.md) for license evidence and notices.
