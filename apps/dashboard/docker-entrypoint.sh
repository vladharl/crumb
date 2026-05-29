#!/bin/sh
set -eu

if [ "${CRUMB_SKIP_MIGRATIONS:-}" = "1" ]; then
  echo "[entrypoint] CRUMB_SKIP_MIGRATIONS=1 — skipping migrations"
else
  echo "[entrypoint] running migrations"
  node packages/db/dist/migrate.mjs
fi

echo "[entrypoint] starting dashboard"
exec "$@"
