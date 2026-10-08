#!/bin/sh
set -eu

# ── Secrets from files (Docker / Kubernetes secrets convention) ──────────
# For any FOO_FILE env var, load FOO from the file's contents unless FOO is
# already set directly. Lets operators mount secrets (DATABASE_URL,
# CRUMB_ENCRYPTION_KEY, STRIPE_SECRET_KEY, *_CLIENT_SECRET, …) as files
# instead of putting them in plaintext env. Runs before migrations + server
# so both processes see the resolved values.
for fvar in $(env | cut -d= -f1 | grep '_FILE$' || true); do
  base="${fvar%_FILE}"
  path="$(eval printf '%s' "\"\${$fvar}\"")"
  cur="$(eval printf '%s' "\"\${$base:-}\"")"
  if [ -n "$path" ] && [ -f "$path" ] && [ -z "$cur" ]; then
    export "$base=$(cat "$path")"
    echo "[entrypoint] loaded $base from $fvar"
  fi
done

# "local" storage with no CRUMB_STORAGE_DIR writes inside the container, which
# every recreate (each upgrade) throws away. Say so on every start.
if [ "${CRUMB_STORAGE_PROVIDER:-local}" = "local" ] && [ -z "${CRUMB_STORAGE_DIR:-}" ]; then
  echo "[entrypoint] WARNING: uploaded files are stored inside this container and are lost when it is recreated. Set CRUMB_STORAGE_PROVIDER=postgres, or point CRUMB_STORAGE_DIR at a mounted volume."
fi

if [ "${CRUMB_SKIP_MIGRATIONS:-}" = "1" ]; then
  echo "[entrypoint] CRUMB_SKIP_MIGRATIONS=1 — skipping migrations"
else
  echo "[entrypoint] running migrations"
  node packages/db/dist/migrate.mjs
fi

# Fresh instance (no workspace yet): print a one-time /onboard setup link, the
# only way to create the first admin. Silent once any workspace exists. Never
# fatal: the dashboard starts either way.
node packages/db/dist/cli.mjs first-run \
  || echo "[entrypoint] could not check for a first run; on a fresh install, get a setup link with: node packages/db/dist/cli.mjs setup-link"

echo "[entrypoint] starting dashboard"
exec "$@"
