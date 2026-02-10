import { Role } from '@catalyst/authorization'
import { Command } from 'commander'
import chalk from 'chalk'
import { createAuthClient } from '../../clients/auth-client.js'
import {
  MintTokenInputSchema,
  VerifyTokenInputSchema,
  RevokeTokenInputSchema,
  ListTokensInputSchema,
} from '../../types.js'

export function tokenCommands(): Command {
  const token = new Command('token').description('Token management (mint, verify, revoke, list)')

  token
    .command('mint')
    .description('Mint a new token')
    .argument('<subject>', 'Token subject (user/service ID)')
    .option('--role <role>', `Role (${Object.values(Role).join(', ')})`, 'USER')
    .option('--name <name>', 'Entity name')
    .option('--type <type>', 'Entity type (user, service)', 'user')
    .option('--expires-in <duration>', 'Expiration (e.g., 1h, 7d, 30m)')
    .option('--node-id <nodeId>', 'Node ID (for NODE role)')
    .option('--trusted-domains <domains>', 'Comma-separated trusted domains')
    .option('--trusted-nodes <nodes>', 'Comma-separated trusted nodes')
    .option('--token <token>', 'Admin auth token')
    .action(async (subject, options, cmd) => {
      const globals = cmd.optsWithGlobals()
      const validation = MintTokenInputSchema.safeParse({
        subject,
        role: options.role,
        name: options.name || subject,
        type: options.type,
        expiresIn: options.expiresIn,
        nodeId: options.nodeId,
        trustedDomains: options.trustedDomains?.split(',').map((d: string) => d.trim()),
        trustedNodes: options.trustedNodes?.split(',').map((n: string) => n.trim()),
        token: options.token || globals.token || process.env.CATALYST_AUTH_TOKEN,
        authUrl: globals.authUrl || process.env.CATALYST_AUTH_URL,
      })

      if (!validation.success) {
        console.error(chalk.red('Invalid input:'))
        validation.error.issues.forEach((issue) => {
          console.error(chalk.yellow(`- ${issue.path.join('.')}: ${issue.message}`))
        })
        process.exit(1)
      }

      if (!validation.data.authUrl) {
        console.error(chalk.red('--auth-url is required for token operations'))
        console.error(chalk.yellow('Set CATALYST_AUTH_URL env var or pass --auth-url flag'))
        process.exit(1)
      }

      try {
        const client = await createAuthClient(validation.data.authUrl)
        const tokensApi = await client.tokens(validation.data.token || '')

        if ('error' in tokensApi) {
          console.error(chalk.red(`✗ Auth failed: ${tokensApi.error}`))
          process.exit(1)
        }

        const newToken = await tokensApi.create({
          subject: validation.data.subject,
          entity: {
            id: validation.data.subject,
            name: validation.data.name,
            type: validation.data.type,
            role: validation.data.role,
            nodeId: validation.data.nodeId,
            trustedDomains: validation.data.trustedDomains,
            trustedNodes: validation.data.trustedNodes,
          },
          roles: [validation.data.role],
          expiresIn: validation.data.expiresIn,
        })

        console.log(chalk.green('✓ Token minted successfully:'))
        console.log(newToken)
        process.exit(0)
      } catch (error) {
        console.error(chalk.red(`✗ Error: ${error instanceof Error ? error.message : error}`))
        process.exit(1)
      }
    })

  token
    .command('verify')
    .description('Verify a token')
    .argument('<token-to-verify>', 'Token to verify')
    .option('--audience <audience>', 'Expected audience')
    .option('--token <token>', 'Auth token')
    .action(async (tokenToVerify, options, cmd) => {
      const globals = cmd.optsWithGlobals()
      const validation = VerifyTokenInputSchema.safeParse({
        tokenToVerify,
        audience: options.audience,
        token: options.token || globals.token || process.env.CATALYST_AUTH_TOKEN,
        authUrl: globals.authUrl || process.env.CATALYST_AUTH_URL,
      })

      if (!validation.success) {
        console.error(chalk.red('Invalid input:'))
        validation.error.issues.forEach((issue) => {
          console.error(chalk.yellow(`- ${issue.path.join('.')}: ${issue.message}`))
        })
        process.exit(1)
      }

      if (!validation.data.authUrl) {
        console.error(chalk.red('--auth-url is required for token operations'))
        console.error(chalk.yellow('Set CATALYST_AUTH_URL env var or pass --auth-url flag'))
        process.exit(1)
      }

      try {
        const client = await createAuthClient(validation.data.authUrl)
        const validationApi = await client.validation(validation.data.token || '')

        if ('error' in validationApi) {
          console.error(chalk.red(`✗ Auth failed: ${validationApi.error}`))
          process.exit(1)
        }

        const result = await validationApi.validate({
          token: validation.data.tokenToVerify,
          audience: validation.data.audience,
        })

        if (result.valid) {
          console.log(chalk.green('✓ Token is valid'))
          console.log(chalk.cyan('Payload:'))
          console.log(JSON.stringify(result.payload, null, 2))
          process.exit(0)
        } else {
          console.log(chalk.red(`✗ Token is invalid: ${result.error}`))
          process.exit(1)
        }
      } catch (error) {
        console.error(chalk.red(`✗ Error: ${error instanceof Error ? error.message : error}`))
        process.exit(1)
      }
    })

  token
    .command('revoke')
    .description('Revoke a token')
    .option('--jti <jti>', 'Token JTI to revoke')
    .option('--san <san>', 'SAN to revoke')
    .option('--token <token>', 'Admin auth token')
    .action(async (options, cmd) => {
      const globals = cmd.optsWithGlobals()
      const validation = RevokeTokenInputSchema.safeParse({
        jti: options.jti,
        san: options.san,
        token: options.token || globals.token || process.env.CATALYST_AUTH_TOKEN,
        authUrl: globals.authUrl || process.env.CATALYST_AUTH_URL,
      })

      if (!validation.success) {
        console.error(chalk.red('Invalid input:'))
        validation.error.issues.forEach((issue) => {
          console.error(chalk.yellow(`- ${issue.message}`))
        })
        process.exit(1)
      }

      if (!validation.data.authUrl) {
        console.error(chalk.red('--auth-url is required for token operations'))
        console.error(chalk.yellow('Set CATALYST_AUTH_URL env var or pass --auth-url flag'))
        process.exit(1)
      }

      try {
        const client = await createAuthClient(validation.data.authUrl)
        const tokensApi = await client.tokens(validation.data.token || '')

        if ('error' in tokensApi) {
          console.error(chalk.red(`✗ Auth failed: ${tokensApi.error}`))
          process.exit(1)
        }

        await tokensApi.revoke({
          jti: validation.data.jti,
          san: validation.data.san,
        })

        console.log(chalk.green('✓ Token revoked successfully.'))
        process.exit(0)
      } catch (error) {
        console.error(chalk.red(`✗ Error: ${error instanceof Error ? error.message : error}`))
        process.exit(1)
      }
    })

  token
    .command('list')
    .description('List tokens')
    .option('--cert-fingerprint <fingerprint>', 'Filter by certificate fingerprint')
    .option('--san <san>', 'Filter by SAN')
    .option('--token <token>', 'Admin auth token')
    .action(async (options, cmd) => {
      const globals = cmd.optsWithGlobals()
      const validation = ListTokensInputSchema.safeParse({
        certificateFingerprint: options.certFingerprint,
        san: options.san,
        token: options.token || globals.token || process.env.CATALYST_AUTH_TOKEN,
        authUrl: globals.authUrl || process.env.CATALYST_AUTH_URL,
      })

      if (!validation.success) {
        console.error(chalk.red('Invalid input:'))
        validation.error.issues.forEach((issue) => {
          console.error(chalk.yellow(`- ${issue.path.join('.')}: ${issue.message}`))
        })
        process.exit(1)
      }

      if (!validation.data.authUrl) {
        console.error(chalk.red('--auth-url is required for token operations'))
        console.error(chalk.yellow('Set CATALYST_AUTH_URL env var or pass --auth-url flag'))
        process.exit(1)
      }

      try {
        const client = await createAuthClient(validation.data.authUrl)
        const tokensApi = await client.tokens(validation.data.token || '')

        if ('error' in tokensApi) {
          console.error(chalk.red(`✗ Auth failed: ${tokensApi.error}`))
          process.exit(1)
        }

        const tokens = await tokensApi.list({
          certificateFingerprint: validation.data.certificateFingerprint,
          san: validation.data.san,
        })

        if (tokens.length === 0) {
          console.log(chalk.yellow('No tokens found.'))
        } else {
          console.table(
            tokens.map((t) => ({
              JTI: t.jti,
              Subject: t.sub,
              IssuedAt: new Date(t.iat * 1000).toISOString(),
              ExpiresAt: new Date(t.exp * 1000).toISOString(),
              Revoked: t.revoked ? 'Yes' : 'No',
            }))
          )
        }
        process.exit(0)
      } catch (error) {
        console.error(chalk.red(`✗ Error: ${error instanceof Error ? error.message : error}`))
        process.exit(1)
      }
    })

  return token
}
