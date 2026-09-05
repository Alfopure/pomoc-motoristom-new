import type { NextConfig } from "next";

const deploymentVersion = process.env.DEPLOYMENT_VERSION?.trim();

const nextConfig: NextConfig = {
  deploymentId: deploymentVersion,
  generateBuildId: async () => deploymentVersion || "local",
  poweredByHeader: false,
  serverExternalPackages: ["@sparticuz/chromium", "playwright-core"],
  outputFileTracingIncludes: { "/api/vehicles/lookup": ["./node_modules/@sparticuz/chromium/bin/**/*"] },
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
