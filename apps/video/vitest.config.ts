import { defineConfig } from 'vitest/config'
import { cedarTextLoader } from '../../packages/authorization/vitest-cedar-plugin.js'
import path from 'path'

export default defineConfig({
  plugins: [cedarTextLoader()],
  resolve: {
    alias: {
      '@orchestrator': path.resolve(__dirname, '../orchestrator/src'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/*container*'],
  },
})
