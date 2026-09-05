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
  ],
};

export default nextConfig;
