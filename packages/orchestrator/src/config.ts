import { z } from 'zod'

export const OrchestratorConfigSchema = z.object({
  authConfig: z
    .object({
      endpoint: z.string().url(),
      jwksUrl: z.string().url().optional(), // JWKS URL for gateway auth
      audience: z.string().optional(), // Expected JWT audience claim
    })
    .optional(),
  gqlGatewayConfig: z
    .object({
      endpoint: z.string().url(),
    })
    .optional(),
})

export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>

export function getConfig(): OrchestratorConfig {
  const authEndpoint = process.env.CATALYST_AUTH_ENDPOINT
  const gatewayEndpoint = process.env.CATALYST_GQL_GATEWAY_ENDPOINT

  const config: OrchestratorConfig = {}

  if (authEndpoint) {
    console.log(`[Config] Found CATALYST_AUTH_ENDPOINT: ${authEndpoint}`)
    // Derive JWKS URL from auth endpoint or use explicit env var
    const jwksUrl =
      process.env.CATALYST_AUTH_JWKS_URL ||
      authEndpoint.replace(/^ws/, 'http').replace(/\/rpc$/, '') + '/.well-known/jwks.json'
    const audience = process.env.CATALYST_AUTH_AUDIENCE
    config.authConfig = {
      endpoint: authEndpoint,
      jwksUrl,
      audience,
    }
    console.log(`[Config] Auth JWKS URL: ${jwksUrl}`)
    if (audience) {
      console.log(`[Config] Auth audience: ${audience}`)
    }
  } else {
    console.log('[Config] No CATALYST_AUTH_ENDPOINT found. Auth disabled.')
  }

  if (gatewayEndpoint) {
    console.log(`[Config] Found CATALYST_GQL_GATEWAY_ENDPOINT: ${gatewayEndpoint}`)
    config.gqlGatewayConfig = {
      endpoint: gatewayEndpoint,
    }
  } else {
    console.log(
      '[Config] No CATALYST_GQL_GATEWAY_ENDPOINT found. GraphQL Gateway integration disabled.'
    )
  }

  // Validate the config
  try {
    return OrchestratorConfigSchema.parse(config)
  } catch (error) {
    console.error('[Config] Invalid configuration:', error)
    throw error
  }
}
