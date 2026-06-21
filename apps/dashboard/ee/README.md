# Crumb Enterprise Edition (ee/)

This directory contains the **cloud-only, feature-gated capabilities** of Crumb Cloud: billing workflows, session replay, AI-assisted triage, and sign-up flows. These features power the hosted product at **crumb-app.localhostlabs.net**.

## Licensing

The code in `ee/` is licensed under the **Business Source License 1.1 (BSL 1.1)**, not AGPL-3.0 like the rest of the repository. See [`LICENSE`](./LICENSE) for the full text.

### What This Means

**You can freely:**
- **Read and evaluate** the source code
- **Develop and test locally** — run the code on your own machine for learning and non-production testing
- **Self-host for your company** — deploy Crumb internally without commercial licensing (evaluation, staging, internal use only)
- **Contribute** — open PRs and forks for personal use or internal benefit

**You cannot:**
- **Use in production** without a commercial license from Localhost Labs LLC
- **Offer as a service** — run this code as a SaaS or hosted offering (even if internally deployed)
- **Commercialize** — resell Crumb Cloud or compete with our hosted offering

### When It Becomes Open Source

On **June 21, 2030**, all code in `ee/` automatically converts to **GNU Affero General Public License 3.0**. After that date, production use and SaaS offerings are fully permitted without a commercial license.

### Commercial Licensing

If you need to use these features in production, offer a hosted version, or want explicit permission — **contact sales@localhostlabs.net** for a commercial license agreement.

## Why BSL?

Crumb is built on open-source infrastructure (Godot, Next.js, PostgreSQL). We want the community to benefit from our work, inspect our code, and contribute. But we also need to sustain development. BSL gives us the best of both:

- **Source-visible**: You can read, learn from, and evaluate all our code
- **Time-limited**: Eventually open-source (no perpetual proprietary lock-in)
- **Fair**: Evaluation and internal use are free; SaaS and production commercialization are licensed

This is the same model used by CockroachDB, Sentry, and other sustainable open-source projects.
