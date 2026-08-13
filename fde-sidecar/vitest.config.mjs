import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['fde-sidecar/tests/**/*.spec.mjs'],
    testTimeout: 30_000,
    hookTimeout: 10_000,
    fileParallelism: false,
  },
})
