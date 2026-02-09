import { configure, getConsoleSink, getLogger } from '@logtape/logtape'

// Configure LogTape for auth service
let configured = false

export function configureLogging() {
  if (configured) return

  configure({
    sinks: {
      console: getConsoleSink(),
    },
    filters: {},
    loggers: [
      {
        category: ['auth'],
        level: 'debug',
        sinks: ['console'],
      },
    ],
  })

  configured = true
}

/**
 * Get a logger for the auth service
 * @param subcategory Optional subcategory like 'permissions', 'tokens', etc.
 */
export function getAuthLogger(subcategory?: string) {
  const category = subcategory ? ['auth', subcategory] : ['auth']
  return getLogger(category)
}
