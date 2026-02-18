import { defineConfig } from 'vitest/config'
import { readFileSync } from 'node:fs'

export default defineConfig({
  plugins: [
    {
      name: 'cedar-loader',
      load(id) {
        if (id.endsWith('.cedar')) {
          const content = readFileSync(id, 'utf-8')
          return `export default ${JSON.stringify(content)}`
        }
      },
    },
  ],
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
