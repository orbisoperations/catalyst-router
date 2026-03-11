import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['tests/e2e/**', 'node_modules/**'],
  },
})
