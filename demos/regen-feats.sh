#!/bin/bash
# Regenerate the docs feature screenshots (capture/features.ts) end to end:
# seed → widget build → dashboard cloud build → standalone serve → stage → capture.
#
# The dashboard sets `output: "standalone"`, so `next start` 500s on traced
# vendor chunks — this serves the standalone server with .next/static and
# public copied in (see demos/README.md). Safe to re-run; touches only the
# dev DB, build output, and /tmp.
set -e
cd "$(dirname "$0")/.."

echo "── 1/6 seed ──────────────────────────────────────"
pnpm db:seed

echo "── 2/6 widget build ──────────────────────────────"
pnpm widget:build

echo "── 3/6 dashboard build:cloud (few minutes) ───────"
pnpm --filter dashboard build:cloud

echo "── 4/6 standalone serve on :3100 ─────────────────"
cd apps/dashboard
lsof -ti :3100 | xargs kill 2>/dev/null || true
sleep 1
rm -rf .next/standalone/apps/dashboard/.next/static .next/standalone/apps/dashboard/public
cp -R .next/static .next/standalone/apps/dashboard/.next/static
cp -R public .next/standalone/apps/dashboard/public
PORT=3100 HOSTNAME=127.0.0.1 \
DATABASE_URL=postgres://crumb:crumb@localhost:5432/crumb \
CRUMB_EDITION=cloud \
nohup node .next/standalone/apps/dashboard/server.js > /tmp/crumb-3100.log 2>&1 &
echo $! > /tmp/crumb-3100.pid
sleep 6
code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3100/login)
echo "login -> $code"
if [ "$code" != "200" ]; then echo "server failed; log tail:"; tail -20 /tmp/crumb-3100.log; exit 1; fi

echo "── 5/6 stage demo DB state ───────────────────────"
cd ../..
pnpm -C demos run stage

echo "── 6/6 capture feature shots ─────────────────────"
CRUMB_DEMO_BASE_URL=http://localhost:3100 pnpm -C demos run features

echo "── result ────────────────────────────────────────"
ls -l docs/assets/screenshots/feat-*.png
echo "PIPELINE DONE (server left running on :3100; pid in /tmp/crumb-3100.pid)"
