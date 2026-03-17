import { readFileSync } from 'node:fs'
import type { Plugin } from 'vite'

/**
 * Vite plugin that loads .cedar and .cedarschema files as raw text.
 * Cedar files use a custom syntax that Vite/Rollup does not
 * understand natively, so this plugin intercepts at the load stage
 * to prevent Rollup from parsing them as JavaScript.
 */
export function cedarTextLoader(): Plugin {
  return {
    name: 'cedar-text-loader',
    enforce: 'pre',
    load(id: string) {
      if (id.endsWith('.cedar') || id.endsWith('.cedarschema')) {
        const content = readFileSync(id, 'utf-8')
        return {
          code: `export default ${JSON.stringify(content)}`,
          map: null,
        }
      }
    },
  }
}
