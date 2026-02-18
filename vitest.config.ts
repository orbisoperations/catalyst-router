import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'apps/**/tests/**/*.{test,spec}.ts',
      'apps/**/src/**/*.{test,spec}.ts',
      'packages/**/tests/**/*.{test,spec}.ts',
      'packages/**/src/**/*.{test,spec}.ts',
      'examples/**/tests/**/*.{test,spec}.ts',
    ],
    exclude: ['**/node_modules/**', '**/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
})
