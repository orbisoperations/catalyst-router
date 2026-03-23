import { defineConfig } from 'vitest/config'
import { cedarTextLoader } from '../../packages/authorization/vitest-cedar-plugin.js'

export default defineConfig({
  plugins: [cedarTextLoader()],
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/*container*'],
  },
})
