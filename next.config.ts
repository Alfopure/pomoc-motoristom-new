import type { NextConfig } from "next";
import { realpathSync } from "node:fs";
import { relative } from "node:path";

const deploymentVersion = process.env.DEPLOYMENT_VERSION?.trim();
// Trace physical package paths: files beneath pnpm aliases collide with symlinks
// when Vercel assembles the function directory.
const playwrightRuntime = relative(process.cwd(), realpathSync("node_modules/playwright-core")).replaceAll("\\", "/");

const nextConfig: NextConfig = {
  deploymentId: deploymentVersion,
  generateBuildId: async () => deploymentVersion || "local",
  poweredByHeader: false,
  serverExternalPackages: ["@sparticuz/chromium", "playwright-core"],
  outputFileTracingIncludes: {
    "/api/cases/*/pdf": [
      "./node_modules/@sparticuz/chromium/bin/**/*",
      `${playwrightRuntime}/browsers.json`,
      `${playwrightRuntime}/lib/**/*`,
      "./src/assets/pdf-fonts/**/*",
    ],
    "/api/vehicles/lookup": [
      "./node_modules/@sparticuz/chromium/bin/**/*",
      // Playwright loads runtime JSON/assets dynamically; Next cannot trace all of them.
      `${playwrightRuntime}/browsers.json`,
      `${playwrightRuntime}/lib/**/*`,
    ],
  },
  headers: async () => [
    {
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      ],
    },
    ...["/handoff", "/api/public/handoffs/:path*"].map(source => ({ source, headers: [
      { key: "Cache-Control", value: "private, no-store, max-age=0" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Robots-Tag", value: "noindex, nofollow" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'; form-action 'self'; base-uri 'self'; object-src 'none'" },
    ] })),
  ],
};

export default nextConfig;
