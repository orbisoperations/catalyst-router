import { defineConfig } from 'vitest/config'
import { cedarTextLoader } from '../../packages/authorization/vitest-cedar-plugin.js'

export default defineConfig({
  test: {
    environment: 'node',
  },
  plugins: [cedarTextLoader()],
})
