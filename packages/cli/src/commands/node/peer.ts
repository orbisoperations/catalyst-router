import { Command } from 'commander'
import chalk from 'chalk'
import { CreatePeerInputSchema, DeletePeerInputSchema, ListPeersInputSchema } from '../../types.js'
import {
  createPeerHandler,
  listPeersHandler,
  deletePeerHandler,
} from '../../handlers/node-peer-handlers.js'

export function peerCommands(): Command {
  const peer = new Command('peer').description('Manage peer connections')

  peer
    .command('create')
    .description('Create a new peer connection')
    .argument('<name>', 'Peer name (FQDN)')
    .argument('<endpoint>', 'WebSocket endpoint (e.g., ws://localhost:3000/rpc)')
    .option('--domains <domains>', 'Comma-separated list of domains')
    .option('--peer-token <token>', 'Token for authenticating with peer')
    .option('--token <token>', 'Auth token for this operation')
    .action(async (name, endpoint, options, cmd) => {
      const globals = cmd.optsWithGlobals()
      const validation = CreatePeerInputSchema.safeParse({
        name,
        endpoint,
        domains: options.domains?.split(',').map((d: string) => d.trim()) || [],
        peerToken: options.peerToken,
        token: options.token || globals.token || process.env.CATALYST_AUTH_TOKEN,
        orchestratorUrl: globals.orchestratorUrl,
      })

      if (!validation.success) {
        console.error(chalk.red('Invalid input:'))
        validation.error.issues.forEach((issue) => {
          console.error(chalk.yellow(`- ${issue.path.join('.')}: ${issue.message}`))
        })
        process.exit(1)
      }

      const result = await createPeerHandler(validation.data)

      if (result.success) {
        console.log(chalk.green(`✓ Peer '${result.data.name}' created successfully.`))
        process.exit(0)
      } else {
        console.error(chalk.red(`✗ Failed to create peer: ${result.error}`))
        process.exit(1)
      }
    })

  peer
    .command('list')
    .description('List all peers')
    .option('--token <token>', 'Auth token')
    .action(async (options, cmd) => {
      const globals = cmd.optsWithGlobals()
      const validation = ListPeersInputSchema.safeParse({
        token: options.token || globals.token || process.env.CATALYST_AUTH_TOKEN,
        orchestratorUrl: globals.orchestratorUrl,
      })

      if (!validation.success) {
        console.error(chalk.red('Invalid input:'))
        validation.error.issues.forEach((issue) => {
          console.error(chalk.yellow(`- ${issue.path.join('.')}: ${issue.message}`))
        })
        process.exit(1)
      }

      const result = await listPeersHandler(validation.data)

      if (result.success) {
        if (result.data.peers.length === 0) {
          console.log(chalk.yellow('No peers found.'))
        } else {
          console.table(
            result.data.peers.map((p) => ({
              Name: p.name,
              Endpoint: p.endpoint,
              Domains: p.domains?.join(', ') || '-',
              Status: p.connectionStatus || 'unknown',
            }))
          )
        }
        process.exit(0)
      } else {
        console.error(chalk.red(`✗ Error: ${result.error}`))
        process.exit(1)
      }
    })

  peer
    .command('delete')
    .description('Delete a peer connection')
    .argument('<name>', 'Peer name to delete')
    .option('--token <token>', 'Auth token')
    .action(async (name, options, cmd) => {
      const globals = cmd.optsWithGlobals()
      const validation = DeletePeerInputSchema.safeParse({
        name,
        token: options.token || globals.token || process.env.CATALYST_AUTH_TOKEN,
        orchestratorUrl: globals.orchestratorUrl,
      })

      if (!validation.success) {
        console.error(chalk.red('Invalid input:'))
        validation.error.issues.forEach((issue) => {
          console.error(chalk.yellow(`- ${issue.path.join('.')}: ${issue.message}`))
        })
        process.exit(1)
      }

      const result = await deletePeerHandler(validation.data)

      if (result.success) {
        console.log(chalk.green(`✓ Peer '${result.data.name}' deleted.`))
        process.exit(0)
      } else {
        console.error(chalk.red(`✗ Failed to delete peer: ${result.error}`))
        process.exit(1)
      }
    })

  return peer
}
