-- +goose NO TRANSACTION
-- +goose Up
-- Reverse dependency lookups filter on these JSON arrays. Without expression indexes every
-- lookup de-TOASTs the dependencies column of the whole catalog. IF NOT EXISTS keeps the
-- migration idempotent where an operator already built the indexes concurrently.
CREATE INDEX CONCURRENTLY IF NOT EXISTS packages_depends_on_cask ON packages USING gin ((dependencies->'dependsOn'->'cask') jsonb_path_ops) WHERE removed_at IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS packages_depends_on_formula ON packages USING gin ((dependencies->'dependsOn'->'formula') jsonb_path_ops) WHERE removed_at IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS packages_runtime_dependencies ON packages USING gin ((dependencies->'runtime') jsonb_path_ops) WHERE removed_at IS NULL;

-- +goose Down
DROP INDEX CONCURRENTLY IF EXISTS packages_runtime_dependencies;
DROP INDEX CONCURRENTLY IF EXISTS packages_depends_on_formula;
DROP INDEX CONCURRENTLY IF EXISTS packages_depends_on_cask;
