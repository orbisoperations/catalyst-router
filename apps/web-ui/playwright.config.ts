import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:3099',
  },
  webServer: {
    command: 'tsx tests/e2e/test-server.ts',
    port: 3099,
    reuseExistingServer: !process.env.CI,
  },
})
