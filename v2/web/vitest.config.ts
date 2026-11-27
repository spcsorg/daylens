import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  test: { include: ["tests/**/*.test.ts"], testTimeout: 120_000, hookTimeout: 120_000, fileParallelism: false },
});
