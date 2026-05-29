import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
};

export default nextConfig;
