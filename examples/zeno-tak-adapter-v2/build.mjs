/* eslint-disable no-undef */
import * as esbuild from 'esbuild'
import { wasmLoader } from 'esbuild-plugin-wasm'

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'esnext',
  format: 'esm',
  outdir: 'dist',
  plugins: [wasmLoader({ mode: 'embedded' })],
  external: ['@tak-ps/node-tak', '@tak-ps/node-cot'],
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
})

console.log('Build complete: dist/index.js')
