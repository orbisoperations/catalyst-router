import { Command } from 'commander'
import chalk from 'chalk'
import { createOrchestratorClient } from '../../clients/orchestrator-client.js'
import { parseOutputFormat, relativeTime } from '../../output.js'

export function statusCommand(): Command {
  return new Command('status')
    .description('Show node health: peers, routes, and journal state at a glance')
    .option('--output <format>', 'Output format: table, json', 'table')
    .option('--token <token>', 'Auth token')
    .action(async (options, cmd) => {
      const globals = cmd.optsWithGlobals()
      const token = options.token || globals.token || process.env.CATALYST_AUTH_TOKEN || ''
      const orchestratorUrl = globals.orchestratorUrl
      const fmt = parseOutputFormat(options)

      try {
        const client = await createOrchestratorClient(orchestratorUrl)

        // Fetch all three in parallel
        const [netResult, dcResult, logResult] = await Promise.all([
          client.getNetworkClient(token),
          client.getDataChannelClient(token),
          client.getLogClient(token),
        ])

        if (!netResult.success) {
          console.error(chalk.red(`[error] Network client: ${netResult.error}`))
          process.exit(1)
        }
        if (!dcResult.success) {
          console.error(chalk.red(`[error] DataChannel client: ${dcResult.error}`))
          process.exit(1)
        }
        if (!logResult.success) {
          console.error(chalk.red(`[error] Log client: ${logResult.error}`))
          process.exit(1)
        }

        const [peers, routes, lastSeq] = await Promise.all([
          netResult.client.listPeers(),
          dcResult.client.listRoutes(),
          logResult.client.lastSeq(),
        ])

        // Only fetch the last entry, not the entire journal
        const lastEntry = lastSeq > 0 ? await logResult.client.getEntry(lastSeq) : null

        const connected = peers.filter((p) => p.connectionStatus === 'connected').length
        const disconnected = peers.length - connected

        if (fmt === 'json') {
          console.log(
            JSON.stringify({
              peers: {
                total: peers.length,
                connected,
                disconnected,
                list: peers.map((p) => ({
                  name: p.name,
                  status: p.connectionStatus,
                  endpoint: p.endpoint,
                })),
              },
              routes: { local: routes.local.length, internal: routes.internal.length },
              journal: { lastSeq, lastActivity: lastEntry?.recorded_at ?? null },
            })
          )
        } else {
          console.log(chalk.bold('\n  Node Status\n'))

          // Peers
          console.log(chalk.bold('  Peers'))
          if (peers.length === 0) {
            console.log(chalk.dim('    (none)'))
          } else {
            for (const p of peers) {
              const icon = p.connectionStatus === 'connected' ? chalk.green('●') : chalk.red('○')
              const status =
                p.connectionStatus === 'connected'
                  ? chalk.green('connected')
                  : chalk.red(p.connectionStatus || 'disconnected')
              console.log(`    ${icon} ${p.name}  ${chalk.dim(p.endpoint || '')}  ${status}`)
            }
          }
          console.log(`    ${chalk.dim(`${connected} connected, ${disconnected} disconnected`)}\n`)

          // Routes
          console.log(chalk.bold('  Routes'))
          if (routes.local.length === 0 && routes.internal.length === 0) {
            console.log(chalk.dim('    (none)'))
          } else {
            for (const r of routes.local) {
              console.log(
                `    ${chalk.cyan('local')}    ${r.name}  ${chalk.dim(r.endpoint)}  ${r.protocol}`
              )
            }
            for (const r of routes.internal) {
              console.log(
                `    ${chalk.magenta('internal')} ${r.name}  ${chalk.dim(r.endpoint || '')}  ${r.protocol}  ${chalk.dim('via ' + r.peer.name)}`
              )
            }
          }
          console.log(
            `    ${chalk.dim(`${routes.local.length} local, ${routes.internal.length} internal`)}\n`
          )

          // Journal
          console.log(chalk.bold('  Journal'))
          console.log(`    Last seq: ${lastSeq}`)
          if (lastEntry) {
            console.log(
              `    Last activity: ${relativeTime(lastEntry.recorded_at)}  (${lastEntry.action.action})`
            )
          } else {
            console.log(chalk.dim('    No activity recorded'))
          }
          console.log()
        }

        process.exit(0)
      } catch (error) {
        console.error(chalk.red(`[error] ${error instanceof Error ? error.message : error}`))
        process.exit(1)
      }
    })
}
