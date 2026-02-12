import { createAuthClient } from '../clients/auth-client.js'
import type {
  MintTokenInput,
  VerifyTokenInput,
  RevokeTokenInput,
  ListTokensInput,
} from '../types.js'
import type { TokenRecord } from '../clients/auth-client.js'

export type MintTokenResult =
  | { success: true; data: { token: string } }
  | { success: false; error: string }

export type VerifyTokenResult =
  | { success: true; data: { valid: true; payload: Record<string, unknown> } }
  | { success: true; data: { valid: false; error: string } }
  | { success: false; error: string }

export type RevokeTokenResult = { success: true } | { success: false; error: string }

export type ListTokensResult =
  | { success: true; data: { tokens: TokenRecord[] } }
  | { success: false; error: string }

/**
 * Mint a new token
 */
export async function mintTokenHandler(input: MintTokenInput): Promise<MintTokenResult> {
  try {
    if (!input.authUrl) {
      return { success: false, error: 'Auth URL is required' }
    }

    const client = await createAuthClient(input.authUrl)
    const tokensApi = await client.tokens(input.token || '')

    if ('error' in tokensApi) {
      return { success: false, error: `Auth failed: ${tokensApi.error}` }
    }

    const newToken = await tokensApi.create({
      subject: input.subject,
      entity: {
        id: input.subject,
        name: input.name,
        type: input.type,
        nodeId: input.nodeId,
        orgDomain: input.orgDomain,
        trustedNodes: input.trustedNodes,
      },
      principal: input.principal,
      expiresIn: input.expiresIn,
    })

    return { success: true, data: { token: newToken } }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Verify a token
 */
export async function verifyTokenHandler(input: VerifyTokenInput): Promise<VerifyTokenResult> {
  try {
    if (!input.authUrl) {
      return { success: false, error: 'Auth URL is required' }
    }

    const client = await createAuthClient(input.authUrl)
    const validationApi = await client.validation(input.token || '')

    if ('error' in validationApi) {
      return { success: false, error: `Auth failed: ${validationApi.error}` }
    }

    const result = await validationApi.validate({
      token: input.tokenToVerify,
      audience: input.audience,
    })

    if (result.valid) {
      return { success: true, data: { valid: true, payload: result.payload || {} } }
    } else {
      return { success: true, data: { valid: false, error: result.error || 'Invalid token' } }
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Revoke a token
 */
export async function revokeTokenHandler(input: RevokeTokenInput): Promise<RevokeTokenResult> {
  try {
    if (!input.authUrl) {
      return { success: false, error: 'Auth URL is required' }
    }

    const client = await createAuthClient(input.authUrl)
    const tokensApi = await client.tokens(input.token || '')

    if ('error' in tokensApi) {
      return { success: false, error: `Auth failed: ${tokensApi.error}` }
    }

    await tokensApi.revoke({
      jti: input.jti,
      san: input.san,
    })

    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * List tokens
 */
export async function listTokensHandler(input: ListTokensInput): Promise<ListTokensResult> {
  try {
    if (!input.authUrl) {
      return { success: false, error: 'Auth URL is required' }
    }

    const client = await createAuthClient(input.authUrl)
    const tokensApi = await client.tokens(input.token || '')

    if ('error' in tokensApi) {
      return { success: false, error: `Auth failed: ${tokensApi.error}` }
    }

    const tokens = await tokensApi.list({
      certificateFingerprint: input.certificateFingerprint,
      san: input.san,
    })

    return { success: true, data: { tokens } }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
