import { defineConfig } from 'vitest/config'
import { cedarTextLoader } from './vitest-cedar-plugin.js'

export default defineConfig({
  test: {
    environment: 'node',
  },
  plugins: [cedarTextLoader()],
})
