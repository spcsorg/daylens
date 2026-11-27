import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  devIndicators: false,
  // The stylesheet imports V2's tokens and fonts from v2/app, outside this folder.
  turbopack: { root: path.resolve(import.meta.dirname, "..") },
  outputFileTracingRoot: path.resolve(import.meta.dirname, ".."),
};

export default config;
