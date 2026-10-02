import type { NextConfig } from "next";
import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { resolveAppEnvironment } from "./src/lib/app-environment";

const deploymentVersion = process.env.DEPLOYMENT_VERSION?.trim();
const diagnosticBuild = [deploymentVersion, process.env.VERCEL_GIT_COMMIT_SHA, "local"].find(value => value && /^[a-zA-Z0-9_-]{1,64}$/.test(value))!;
// Trace physical package paths: files beneath pnpm aliases collide with symlinks
// when Vercel assembles the function directory.
const playwrightRuntime = relative(process.cwd(), realpathSync("node_modules/playwright-core")).replaceAll("\\", "/");

const nextConfig: NextConfig = {
  deploymentId: deploymentVersion,
  env: { NEXT_PUBLIC_DIAGNOSTICS_BUILD_ID: diagnosticBuild, NEXT_PUBLIC_DIAGNOSTICS_ENVIRONMENT: resolveAppEnvironment() },
  generateBuildId: async () => deploymentVersion || "local",
  // Only the private artifact script enables maps, then removes them from public output.
  productionBrowserSourceMaps: process.env.DIAGNOSTICS_PRIVATE_SOURCE_MAPS === "1",
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
