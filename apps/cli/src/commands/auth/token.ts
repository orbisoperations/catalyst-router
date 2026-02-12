import { Principal } from '@catalyst/authorization'
import { Command } from 'commander'
import chalk from 'chalk'
import {
  MintTokenInputSchema,
  VerifyTokenInputSchema,
  RevokeTokenInputSchema,
  ListTokensInputSchema,
} from '../../types.js'
import {
  mintTokenHandler,
  verifyTokenHandler,
  revokeTokenHandler,
  listTokensHandler,
} from '../../handlers/auth-token-handlers.js'

export function tokenCommands(): Command {
  const token = new Command('token').description('Token management (mint, verify, revoke, list)')

  token
    .command('mint')
    .description('Mint a new token')
    .argument('<subject>', 'Token subject (user/service ID)')
    .option(
      '--principal <principal>',
      `Principal (${Object.values(Principal).join(', ')})`,
      Principal.USER
    )
    .option('--name <name>', 'Entity name')
    .option('--type <type>', 'Entity type (user, service)', 'user')
    .option('--expires-in <duration>', 'Expiration (e.g., 1h, 7d, 30m)')
    .option('--node-id <nodeId>', 'Node ID (for NODE principal)')
    .option('--org-domain <domain>', 'Organization domain')
    .option('--trusted-nodes <nodes>', 'Comma-separated trusted nodes')
    .option('--token <token>', 'Admin auth token')
    .action(async (subject, options, cmd) => {
      const globals = cmd.optsWithGlobals()
      const validation = MintTokenInputSchema.safeParse({
        subject,
        principal: options.principal,
        name: options.name || subject,
        type: options.type,
        expiresIn: options.expiresIn,
        nodeId: options.nodeId,
        orgDomain: options.orgDomain,
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

      const result = await mintTokenHandler(validation.data)

      if (result.success) {
        console.log(chalk.green('[ok] Token minted successfully:'))
        console.log(result.data.token)
        process.exit(0)
      } else {
        console.error(chalk.red(`[error] ${result.error}`))
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

      const result = await verifyTokenHandler(validation.data)

      if (!result.success) {
        console.error(chalk.red(`[error] ${result.error}`))
        process.exit(1)
      }

      if (result.data.valid) {
        console.log(chalk.green('[ok] Token is valid'))
        console.log(chalk.cyan('Payload:'))
        console.log(JSON.stringify(result.data.payload, null, 2))
        process.exit(0)
      } else {
        console.log(chalk.red(`[error] Token is invalid: ${result.data.error}`))
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

      const result = await revokeTokenHandler(validation.data)

      if (result.success) {
        console.log(chalk.green('[ok] Token revoked successfully.'))
        process.exit(0)
      } else {
        console.error(chalk.red(`[error] ${result.error}`))
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

      const result = await listTokensHandler(validation.data)

      if (!result.success) {
        console.error(chalk.red(`[error] ${result.error}`))
        process.exit(1)
      }

      if (result.data.tokens.length === 0) {
        console.log(chalk.yellow('No tokens found.'))
      } else {
        console.table(
          result.data.tokens.map((t) => ({
            JTI: t.jti,
            Subject: t.sub,
            IssuedAt: new Date(t.iat * 1000).toISOString(),
            ExpiresAt: new Date(t.exp * 1000).toISOString(),
            Revoked: t.revoked ? 'Yes' : 'No',
          }))
        )
      }
      process.exit(0)
    })

  return token
}
