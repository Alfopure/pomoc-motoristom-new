import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  // Keep parent application entrypoints (especially src/proxy.ts) outside this
  // app's source root while allowing pnpm's shared dependency symlink targets.
  turbopack: { root: __dirname },
  experimental: {
    turbopackAdditionalRoots: {
      workspaceDependencies: { path: path.resolve(__dirname, "../../node_modules") },
    },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};
export default config;
