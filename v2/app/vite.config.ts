import path from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  root: path.join(import.meta.dirname, 'renderer'),
  base: './',
  esbuild: { jsx: 'automatic' },
  build: {
    outDir: path.join(import.meta.dirname, 'renderer', 'dist'),
    emptyOutDir: true,
    target: 'chrome140',
    modulePreload: false,
    reportCompressedSize: false,
  },
})
