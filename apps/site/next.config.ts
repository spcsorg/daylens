import { existsSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

// Each version lives at /<variant>; "/" is rewritten to the one SITE_VARIANT names.
const V2 = ["beam", "ramp", "superlogical", "update", "chatgpt", "rize", "toggl", "launch"];
const variant = process.env.SITE_VARIANT || "a";
const assets = process.env.NEXT_PUBLIC_ASSET_PATH || "";
const routes = process.env.NEXT_PUBLIC_ROUTE_BASE || "";

const nextConfig: NextConfig = {
  // Separate build dirs let the three layout versions run side by side.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  assetPrefix: assets || undefined,
  env: { NEXT_PUBLIC_SITE_VARIANT: variant },
  // Builds skip the type files that running dev servers rewrite in their own dist dirs.
  typescript: { tsconfigPath: process.env.NEXT_DIST_DIR?.startsWith(".next-build") ? "tsconfig.build.json" : "tsconfig.json" },
  // The workspace hoists next into the repo root; a Vercel deploy uploads apps/site alone.
  turbopack: { root: existsSync(path.join(__dirname, "node_modules/next")) ? __dirname : path.resolve(__dirname, "../..") },
  images: { formats: ["image/avif", "image/webp"], qualities: [80, 90] },
  async rewrites() {
    const home = V2.includes(variant) ? [{ source: "/", destination: `/${variant}` }] : [];
    // The prefixed paths are also served here, so this deployment works on its own domain too.
    const prefixed = assets ? [{ source: `${assets}/:path*`, destination: "/:path*" }] : [];
    // Page links carry the other site's path; this deployment answers them too.
    const routed = routes
      ? [
          { source: routes, destination: home.length ? home[0].destination : "/" },
          { source: `${routes}/:path*`, destination: "/:path*" },
        ]
      : [];
    return { beforeFiles: [...prefixed, ...routed, ...home], afterFiles: [], fallback: [] };
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
