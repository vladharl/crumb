# syntax=docker/dockerfile:1.6
# Multi-stage build for the Crumb dashboard.
# Build with the repo root as context:  docker build -f apps/dashboard/Dockerfile .

# ─── base: pnpm + corepack ───────────────────────────────────
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.3.0 --activate
WORKDIR /repo

# ─── deps: install node_modules for all workspaces ───────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/widget/package.json apps/widget/
COPY packages/ui/package.json packages/ui/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile

# ─── builder: widget bundle, Next standalone, bundled migrate runner ─
FROM deps AS builder
ENV NEXT_TELEMETRY_DISABLED=1
# Build-time edition. `community` (default, self-host) strips the cloud-only
# routes (scripts/apply-ee.mjs) and aliases the cloud SDKs to stubs, so the
# Next standalone trace ships WITHOUT stripe / @anthropic-ai/sdk or the
# Stripe-billing & session-replay routes. `cloud` keeps everything. A full
# install above is fine: the standalone trace, not node_modules, decides what
# the runner image ships, and keeping the SDK types here lets the build's
# typecheck of ee/** succeed in both editions.
ARG CRUMB_EDITION=community
ENV CRUMB_EDITION=$CRUMB_EDITION
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN pnpm --filter @crumb/widget build \
 && pnpm --filter @crumb/db build:migrate \
 && pnpm --filter @crumb/db build:cli \
 && pnpm --filter @crumb/db exec esbuild src/backfill-encrypt-secrets.ts --bundle --platform=node --target=node20 --format=esm --packages=bundle --outfile=dist/backfill-encrypt-secrets.mjs \
 && if [ "$CRUMB_EDITION" = "cloud" ]; then pnpm --filter dashboard build:cloud; else pnpm --filter dashboard build:community; fi

# ─── runner: minimal image, non-root, runs migrations then server ─
FROM node:22-alpine AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NODE_OPTIONS=--enable-source-maps
WORKDIR /app

RUN addgroup --system --gid 1001 crumb \
 && adduser  --system --uid 1001 --ingroup crumb crumb

# Next.js standalone bundle ships server.js plus its traced node_modules.
COPY --from=builder --chown=crumb:crumb /repo/apps/dashboard/.next/standalone ./
COPY --from=builder --chown=crumb:crumb /repo/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=builder --chown=crumb:crumb /repo/apps/dashboard/public ./apps/dashboard/public

# Self-contained bundles (no node_modules needed) + SQL migrations: the migrate
# runner, the operator CLI (setup-link / add-user / list-users) and the
# encryption backfill. Run the last two with
#   docker compose exec dashboard node packages/db/dist/<name>.mjs
COPY --from=builder --chown=crumb:crumb /repo/packages/db/dist ./packages/db/dist
COPY --from=builder --chown=crumb:crumb /repo/packages/db/drizzle ./packages/db/drizzle

COPY --chown=crumb:crumb apps/dashboard/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

USER crumb
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "apps/dashboard/server.js"]
