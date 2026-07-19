import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Build-time edition. `community` (default, self-host) excludes cloud-only
// code; `cloud` keeps it. CRUMB_EDITION is a BUILD concern (what compiles in);
// CRUMB_TIER stays a RUNTIME concern (behaviour within the cloud edition).
const EDITION = (process.env.CRUMB_EDITION ?? "community").toLowerCase();
const IS_CLOUD = EDITION === "cloud";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  // Trace workspace packages from the monorepo root so the standalone bundle
  // includes @crumb/ui, @crumb/db, drizzle-orm, postgres, etc.
  experimental: {
    outputFileTracingRoot: resolve(__dirname, "..", ".."),
  },
  transpilePackages: ["@crumb/ui", "@crumb/db"],

  // Inlined into client bundles so client components can gate cloud-only UI
  // (e.g. the Billing nav item) at build time.
  env: { NEXT_PUBLIC_CRUMB_EDITION: EDITION },

  // Community build: replace the cloud-only lib wrappers with SDK-free stubs so
  // neither the heavy Stripe SDK NOR the cloud logic itself (Stripe client
  // config, AI prompts + the aistack client) enter the bundle. The stubs mirror
  // the disabled self-host runtime, so every caller compiles + behaves.
  //
  // We use NormalModuleReplacementPlugin, not resolve.alias: Next resolves the
  // `@/*` tsconfig paths via its own JsConfigPathsPlugin, which beats a
  // resolve.alias entry for the same specifier (the alias silently no-ops).
  // NormalModuleReplacementPlugin rewrites the request in `beforeResolve`,
  // before the paths plugin runs, so the swap actually takes effect.
  webpack: (config, { webpack }) => {
    if (!IS_CLOUD) {
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(
          /^@\/lib\/stripe$/,
          resolve(__dirname, "lib/stripe.community.ts"),
        ),
        new webpack.NormalModuleReplacementPlugin(
          /^@\/lib\/ai\/cluster$/,
          resolve(__dirname, "lib/ai/cluster.community.ts"),
        ),
        new webpack.NormalModuleReplacementPlugin(
          /^@\/lib\/ai\/ticket$/,
          resolve(__dirname, "lib/ai/ticket.community.ts"),
        ),
        // New AI features (cloud-only). Each real module imports the aistack /
        // embeddings client; the community stub returns null/false so neither
        // the client nor the prompts enter the self-host bundle.
        new webpack.NormalModuleReplacementPlugin(
          /^@\/lib\/ai\/embeddings$/,
          resolve(__dirname, "lib/ai/embeddings.community.ts"),
        ),
        new webpack.NormalModuleReplacementPlugin(
          /^@\/lib\/ai\/triage$/,
          resolve(__dirname, "lib/ai/triage.community.ts"),
        ),
        // Autopilot extraction/relevance gate — cloud-only. The community stub
        // returns "not configured" so the feedback sync lands raw captures.
        new webpack.NormalModuleReplacementPlugin(
          /^@\/lib\/ai\/extract-feedback$/,
          resolve(__dirname, "lib/ai/extract-feedback.community.ts"),
        ),
        // Note: lib/ai/dedup.ts is intentionally NOT replaced — it's pure
        // pgvector SQL with no aistack import, and degrades to "no candidates"
        // on self-host (item_embeddings is empty there), so it's bundle-safe.
        new webpack.NormalModuleReplacementPlugin(
          /^@\/lib\/ai\/ask$/,
          resolve(__dirname, "lib/ai/ask.community.ts"),
        ),
        new webpack.NormalModuleReplacementPlugin(
          /^@\/lib\/ai\/ask-usage$/,
          resolve(__dirname, "lib/ai/ask-usage.community.ts"),
        ),
        new webpack.NormalModuleReplacementPlugin(
          /^@\/lib\/ai\/reply$/,
          resolve(__dirname, "lib/ai/reply.community.ts"),
        ),
        new webpack.NormalModuleReplacementPlugin(
          /^@\/lib\/ai\/replay-summary$/,
          resolve(__dirname, "lib/ai/replay-summary.community.ts"),
        ),
        new webpack.NormalModuleReplacementPlugin(
          /^@\/lib\/ai\/match-account$/,
          resolve(__dirname, "lib/ai/match-account.community.ts"),
        ),
        // Slack Phase-0 request sizing — cloud-only. The community stub returns
        // null so the Slack events route compiles but posts the "needs Cloud
        // AI" note instead of sizing.
        new webpack.NormalModuleReplacementPlugin(
          /^@\/lib\/ai\/size-request$/,
          resolve(__dirname, "lib/ai/size-request.community.ts"),
        ),
      );
      // Belt-and-suspenders: make the heavy Stripe SDK resolve to an empty
      // module so any stray/direct import (e.g. the webhook route's
      // `import type Stripe from "stripe"`) can never pull it into the
      // community bundle. Cloud builds skip this and resolve it normally.
      // (The AI path needs no alias — it's plain fetch, no SDK to exclude.)
      config.resolve.alias = {
        ...config.resolve.alias,
        stripe: false,
      };
    }
    return config;
  },

  // Security headers applied to every response. These are safe defaults that
  // don't restrict the app's own resource loading:
  //   - HSTS pins https (ignored by browsers over http, so dev is unaffected).
  //   - frame-ancestors 'self' + X-Frame-Options block clickjacking of the
  //     dashboard. The embed widget loads as a <script> on customer sites
  //     (not an iframe of our origin), so this doesn't affect it.
  //   - nosniff, Referrer-Policy, Permissions-Policy are standard hardening.
  // A full script/style CSP is intentionally NOT set here — the UI relies on
  // inline styles + Next's inline hydration, so a strict policy needs nonce
  // wiring + testing (tracked as a follow-up). object-src/base-uri are safe
  // to lock down now.
  async headers() {
    const securityHeaders = [
      { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'self'; base-uri 'self'; object-src 'none'" },
    ];
    return [{ source: "/:path*", headers: securityHeaders }];
  },

  // Retired routes folded into other surfaces:
  //   /notifications → bell popover (feed) + Settings → Notifications (prefs)
  //   /captures      → merged into the Inbox (triage rows)
  async redirects() {
    return [
      { source: "/notifications", destination: "/inbox", permanent: false },
      { source: "/captures", destination: "/inbox", permanent: false },
    ];
  },
};

export default nextConfig;
