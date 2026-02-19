import type { Plugin } from 'vite'

/**
 * Vite plugin that loads .cedar policy files as raw text.
 * Cedar files use `import ... with { type: 'text' }` which Bun
 * handles natively but Vite/Rollup does not understand.
 */
export function cedarTextLoader(): Plugin {
  return {
    name: 'cedar-text-loader',
    transform(_code: string, id: string) {
      if (id.endsWith('.cedar')) {
        return {
          code: `import { readFileSync } from 'node:fs'\nexport default readFileSync(${JSON.stringify(id)}, 'utf-8')`,
          map: null,
        }
      }
    },
  }
}
