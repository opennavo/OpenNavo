# MinIO development-image dependency lock

These manifests belong to the upstream MinIO source at
`RELEASE.2025-10-15T17-29-55Z` (`9e49d5e7a648`), not the OpenNavo server module.
`ops/Dockerfile.minio` retrieves that source, overlays these exact manifests,
and builds with `-mod=readonly` using Go 1.27.2.

The reviewed dependency upgrades include thrift, jsonparser, go-jose,
Prometheus, AMQP, OpenTelemetry, x/crypto, x/net, x/text, gRPC, protobuf,
edwards25519, NTLM, MQTT, and the MongoDB driver. To update this lock, copy the
pinned upstream source to an isolated directory, change its dependencies,
compile and test its S3 behavior, then copy its go.mod/go.sum back here.
Do not run `go mod tidy` on this manifest-only directory.

The source and modified manifests are included in the resulting image under
`/usr/share/doc/minio/minio`, with collected third-party licenses alongside.
The upstream server is archived and still has unresolved source-level
vulnerabilities. See `docs/security/DEPENDENCY_SECURITY.md` in the repository.
A rebuilt `(devel)` main module is not evidence that those CVEs are fixed.
This image is for isolated local development/verification, not production.
