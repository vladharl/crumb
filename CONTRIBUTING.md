# Contributing to Crumb

Thanks for your interest in Crumb — the open-source customer feedback tool that ties feedback to revenue and closes the loop. Contributions of all sizes are welcome: bug reports, docs fixes, and pull requests.

## Ways to contribute

- **Report a bug** or request a feature: open a [GitHub issue](https://github.com/vladharl/crumb/issues). Please search first to avoid duplicates.
- **Pick up a `good first issue`**: issues labelled [`good first issue`](https://github.com/vladharl/crumb/labels/good%20first%20issue) are scoped to be approachable.
- **Improve the docs**: typos, clearer setup steps, and missing details are all fair game.
- **Send a pull request**: see the workflow below.

## Local development

You'll need **Node 22+**, **pnpm 11+**, and **Docker** (for Postgres).

```bash
pnpm install
pnpm db:up         # boots Postgres 16 (with pgvector) in Docker on :5432
export DATABASE_URL=postgres://crumb:crumb@localhost:5432/crumb
pnpm db:migrate    # applies the migrations, which also create the pgcrypto + vector extensions
pnpm db:seed       # seeds the sample "southbeam" workspace
pnpm widget:build  # builds the embed widget → apps/dashboard/public/widget.js
cp apps/dashboard/.env.local.example apps/dashboard/.env.local
pnpm dev           # → http://localhost:3000
```

Log in at `http://localhost:3000/login` as a seeded admin (e.g. `lina@southbeam.io`); magic links print to the dev terminal by default. See the [README](README.md) for the full setup, env vars, and self-hosting guide.

## Project layout

```
apps/dashboard/   Next.js dashboard (vendor side) + public /api/v1
apps/widget/      the customer-facing embed (vanilla TS → IIFE)
packages/db/      Drizzle schema + Postgres client + seed
packages/ui/      shared design system (icons, atoms, status)
demos/            Playwright → Remotion demo pipeline
```

### Editions

Crumb ships from one repo as two builds. The default **community** build is open source under **AGPL-3.0**. The cloud-only routes live in `apps/dashboard/ee/` and are licensed under the **Business Source License 1.1** (see `apps/dashboard/ee/LICENSE`). `pnpm dev` builds the cloud edition so you can run every feature locally; `pnpm --filter dashboard build:community` builds the open-source edition.

## Before you open a PR

- **Type-check and test:**
  ```bash
  (cd apps/dashboard && npx tsc --noEmit)
  pnpm --filter dashboard test
  ```
- **Match the surrounding code.** Follow the existing TypeScript style and patterns; keep changes focused.
- **One logical change per PR.** Smaller PRs get reviewed faster.
- **Reference the issue** your PR addresses (e.g. "Closes #123") and describe what changed and why.
- **Schema changes** go in `packages/db/src/schema.ts`; then run `pnpm db:generate` and commit the new migration under `packages/db/drizzle/`.
- **Update docs** if you changed behavior, env vars, or the API. A new env var belongs in `apps/dashboard/.env.local.example`; Docker Compose passes everything in `.env` to the container, so there's no compose allowlist to update.

CI runs type-checks, unit tests, and a both-edition build on every PR, plus a secrets scan — please make sure those pass.

## Licensing of contributions

By contributing, you agree that your contributions to the open-source parts of the project are licensed under **AGPL-3.0**, and contributions to files under `apps/dashboard/ee/` are licensed under the **BSL 1.1** that governs that directory.

## Questions

Open a [discussion or issue](https://github.com/vladharl/crumb/issues), or email **hello@localhostlabs.net**. Thanks for helping make Crumb better.
