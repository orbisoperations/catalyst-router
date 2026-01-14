import { Command } from 'commander'
import { WebSocket } from 'ws'
import { newWebSocketRpcSession } from 'capnweb'
import chalk from 'chalk'
import type { SignTokenRequest, SignTokenResponse } from '@catalyst/auth/rpc/schema'

// RPC stub interface (what the remote service exposes)
interface AuthRpcStub {
  signToken(request: SignTokenRequest): Promise<SignTokenResponse>
}

/**
 * Create an auth service RPC client
 */
function createAuthClient(endpoint: string): AuthRpcStub {
  // Polyfill WebSocket for CapnWeb in Node environment
  if (!globalThis.WebSocket) {
    // @ts-expect-error WebSocket is not typed
    globalThis.WebSocket = WebSocket
  }

  return newWebSocketRpcSession(endpoint, {
    WebSocket: WebSocket as any,
  }) as unknown as AuthRpcStub
}

/**
 * Parse JSON claims from CLI input
 */
export function parseClaims(claimsJson?: string): Record<string, unknown> | undefined {
  if (!claimsJson) {
    return undefined
  }

  try {
    const parsed = JSON.parse(claimsJson)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Claims must be a JSON object')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON for claims: ${error.message}`)
    }
    throw error
  }
}

/**
 * Generate a service token via the auth service RPC
 */
async function generateToken(
  subject: string,
  options: {
    audience?: string[]
    expiresIn?: string
    claims?: string
    authEndpoint?: string
    raw?: boolean
  }
): Promise<void> {
  const authEndpoint =
    options.authEndpoint || process.env.CATALYST_AUTH_ENDPOINT || 'ws://localhost:4020/rpc'

  let client: AuthRpcStub | null = null
  try {
    client = createAuthClient(authEndpoint)

    // Parse claims if provided
    let parsedClaims: Record<string, unknown> | undefined
    if (options.claims) {
      parsedClaims = parseClaims(options.claims)
    }

    // Build request
    const request: SignTokenRequest = {
      subject,
      ...(options.audience &&
        options.audience.length > 0 && {
          audience: options.audience.length === 1 ? options.audience[0] : options.audience,
        }),
      ...(options.expiresIn && { expiresIn: options.expiresIn }),
      ...(parsedClaims && { claims: parsedClaims }),
    }

    // Call RPC
    const response = await client.signToken(request)

    if (!response.success) {
      console.error(chalk.red('Failed to generate token:'), response.error)
      process.exit(1)
    }

    // Output result
    if (options.raw) {
      // Raw output: just the token, no newline (for piping)
      process.stdout.write(response.token)
    } else {
      // Formatted output: JSON with token and metadata
      const output = {
        token: response.token,
        subject,
        ...(options.audience && options.audience.length > 0 && { audience: options.audience }),
        ...(options.expiresIn && { expiresIn: options.expiresIn }),
        ...(parsedClaims && { claims: parsedClaims }),
      }
      console.log(JSON.stringify(output, null, 2))
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error(chalk.red('Error generating token:'), message)
    process.exit(1)
  }
}

export function serviceTokenCommands() {
  const serviceToken = new Command('service-token').description('Generate service tokens')

  serviceToken
    .command('generate')
    .description('Generate a new JWT service token')
    .requiredOption('-s, --subject <subject>', 'Token subject (required)')
    .option(
      '-a, --audience <audience>',
      'Token audience (can be specified multiple times)',
      (value, previous: string[] = []) => {
        return [...previous, value]
      },
      []
    )
    .option(
      '-e, --expires-in <duration>',
      "Token expiration (format: '1h', '30m', '7d', etc., default: '1h')"
    )
    .option(
      '-c, --claims <json>',
      'Custom claims as JSON string (e.g., \'{"role":"admin","permissions":["read","write"]}\')'
    )
    .option('-r, --raw', 'Output only the raw JWT token (no formatting, useful for piping)')
    .option(
      '--auth-endpoint <url>',
      'Auth service RPC endpoint (defaults to CATALYST_AUTH_ENDPOINT env var or ws://localhost:4020/rpc)'
    )
    .action(async (options) => {
      await generateToken(options.subject, {
        audience:
          Array.isArray(options.audience) && options.audience.length > 0
            ? options.audience
            : undefined,
        expiresIn: options.expiresIn,
        claims: options.claims,
        authEndpoint: options.authEndpoint,
        raw: options.raw,
      })
    })

  return serviceToken
}
