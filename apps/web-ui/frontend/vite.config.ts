import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiProxyTarget = env.CATALYST_WEB_UI_PROXY_TARGET || 'http://localhost:3100'

  return {
    plugins: [react()],
    root: './frontend',
    base: '/',
    build: {
      outDir: '../dist/frontend',
      emptyOutDir: true,
    },
    server: {
      proxy: {
        '/api': {
          target: apiProxyTarget,
        },
      },
    },
  }
})
