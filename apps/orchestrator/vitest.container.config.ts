import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/container/**/*.{test,spec}.ts'],
    globalSetup: ['tests/container/global-setup.ts'],
    fileParallelism: false,
  },
})
