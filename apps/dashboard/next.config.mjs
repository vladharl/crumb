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
};

export default nextConfig;
