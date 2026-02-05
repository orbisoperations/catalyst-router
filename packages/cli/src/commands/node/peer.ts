import { Command } from 'commander'
import chalk from 'chalk'
import { createOrchestratorClient } from '../../clients/orchestrator-client.js'
import { CreatePeerInputSchema, DeletePeerInputSchema, ListPeersInputSchema } from '../../types.js'

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

      try {
        const client = await createOrchestratorClient(validation.data.orchestratorUrl)
        const mgmtScope = client.connectionFromManagementSDK()

        const result = await mgmtScope.applyAction({
          resource: 'internalBGPConfig',
          resourceAction: 'create',
          data: {
            name: validation.data.name,
            endpoint: validation.data.endpoint,
            domains: validation.data.domains,
            peerToken: validation.data.peerToken,
          },
        })

        if (result.success) {
          console.log(chalk.green(`✓ Peer '${name}' created successfully.`))
          process.exit(0)
        } else {
          console.error(chalk.red(`✗ Failed to create peer: ${result.error}`))
          process.exit(1)
        }
      } catch (error) {
        console.error(chalk.red(`✗ Error: ${error instanceof Error ? error.message : error}`))
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

      try {
        const client = await createOrchestratorClient(validation.data.orchestratorUrl)
        const mgmtScope = client.connectionFromManagementSDK()

        const result = await mgmtScope.listPeers()

        if (result.peers.length === 0) {
          console.log(chalk.yellow('No peers found.'))
        } else {
          console.table(
            result.peers.map((p) => ({
              Name: p.name,
              Endpoint: p.endpoint,
              Domains: p.domains?.join(', ') || '-',
              Status: p.connectionStatus || 'unknown',
            }))
          )
        }
        process.exit(0)
      } catch (error) {
        console.error(chalk.red(`✗ Error: ${error instanceof Error ? error.message : error}`))
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

      try {
        const client = await createOrchestratorClient(validation.data.orchestratorUrl)
        const mgmtScope = client.connectionFromManagementSDK()

        const result = await mgmtScope.deletePeer(validation.data.name)

        if (result.success) {
          console.log(chalk.green(`✓ Peer '${name}' deleted.`))
          process.exit(0)
        } else {
          console.error(chalk.red(`✗ Failed to delete peer: ${result.error}`))
          process.exit(1)
        }
      } catch (error) {
        console.error(chalk.red(`✗ Error: ${error instanceof Error ? error.message : error}`))
        process.exit(1)
      }
    })

  return peer
}
