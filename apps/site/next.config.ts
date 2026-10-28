import { existsSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

const assets = process.env.NEXT_PUBLIC_ASSET_PATH || "";
const routes = process.env.NEXT_PUBLIC_ROUTE_BASE || "";

const nextConfig: NextConfig = {
  assetPrefix: assets || undefined,
  // The workspace hoists next into the repo root; a Vercel deploy uploads apps/site alone.
  turbopack: { root: existsSync(path.join(__dirname, "node_modules/next")) ? __dirname : path.resolve(__dirname, "../..") },
  images: { formats: ["image/avif", "image/webp"], qualities: [80, 90] },
  async rewrites() {
    // The prefixed paths are also served here, so this deployment works on its own domain too.
    const prefixed = assets ? [{ source: `${assets}/:path*`, destination: "/:path*" }] : [];
    // Page links carry the other site's path; this deployment answers them too.
    const routed = routes
      ? [
          { source: routes, destination: "/launch" },
          { source: `${routes}/:path*`, destination: "/:path*" },
        ]
      : [];
    return { beforeFiles: [...prefixed, ...routed, { source: "/", destination: "/launch" }], afterFiles: [], fallback: [] };
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
