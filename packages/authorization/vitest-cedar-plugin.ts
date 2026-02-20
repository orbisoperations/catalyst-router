import type { Plugin } from 'vite'

/**
 * Vite plugin that loads .cedar and .cedarschema files as raw text.
 * Cedar files use a custom syntax that Vite/Rollup does not
 * understand natively, so this plugin loads them as raw text.
 */
export function cedarTextLoader(): Plugin {
  return {
    name: 'cedar-text-loader',
    transform(_code: string, id: string) {
      if (id.endsWith('.cedar') || id.endsWith('.cedarschema')) {
        return {
          code: `import { readFileSync } from 'node:fs'\nexport default readFileSync(${JSON.stringify(id)}, 'utf-8')`,
          map: null,
        }
      }
    },
  }
}
