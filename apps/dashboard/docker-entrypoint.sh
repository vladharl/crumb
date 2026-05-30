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

if [ "${CRUMB_SKIP_MIGRATIONS:-}" = "1" ]; then
  echo "[entrypoint] CRUMB_SKIP_MIGRATIONS=1 — skipping migrations"
else
  echo "[entrypoint] running migrations"
  node packages/db/dist/migrate.mjs
fi

echo "[entrypoint] starting dashboard"
exec "$@"
