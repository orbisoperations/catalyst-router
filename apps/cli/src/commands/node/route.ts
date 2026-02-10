import { Command } from 'commander'
import chalk from 'chalk'
import { createOrchestratorClient } from '../../clients/orchestrator-client.js'
import {
  CreateRouteInputSchema,
  DeleteRouteInputSchema,
  ListRoutesInputSchema,
} from '../../types.js'

export function routeCommands(): Command {
  const route = new Command('route').description('Manage local routes')

  route
    .command('create')
    .description('Create a new local route')
    .argument('<name>', 'Route name')
    .argument('<endpoint>', 'Service endpoint URL')
    .option(
      '-p, --protocol <protocol>',
      'Protocol (http, http:graphql, http:gql, http:grpc)',
      'http:graphql'
    )
    .option('--region <region>', 'Region tag')
    .option('--tags <tags>', 'Comma-separated tags')
    .option('--token <token>', 'Auth token')
    .action(async (name, endpoint, options, cmd) => {
      const globals = cmd.optsWithGlobals()
      const validation = CreateRouteInputSchema.safeParse({
        name,
        endpoint,
        protocol: options.protocol,
        region: options.region,
        tags: options.tags?.split(',').map((t: string) => t.trim()),
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
          resource: 'localRoute',
          resourceAction: 'create',
          data: {
            name: validation.data.name,
            endpoint: validation.data.endpoint,
            protocol: validation.data.protocol,
            region: validation.data.region,
            tags: validation.data.tags,
          },
        })

        if (result.success) {
          console.log(chalk.green(`[ok] Route '${name}' created successfully.`))
          process.exit(0)
        } else {
          console.error(chalk.red(`[error] Failed to create route: ${result.error}`))
          process.exit(1)
        }
      } catch (error) {
        console.error(chalk.red(`[error] Error: ${error instanceof Error ? error.message : error}`))
        process.exit(1)
      }
    })

  route
    .command('list')
    .description('List all routes (local and internal)')
    .option('--token <token>', 'Auth token')
    .action(async (options, cmd) => {
      const globals = cmd.optsWithGlobals()
      const validation = ListRoutesInputSchema.safeParse({
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

        const result = await mgmtScope.listLocalRoutes()
        const allRoutes = [
          ...result.routes.local.map((r) => ({ ...r, source: 'local' })),
          ...result.routes.internal.map((r) => ({ ...r, source: 'internal', peer: r.peerName })),
        ]

        if (allRoutes.length === 0) {
          console.log(chalk.yellow('No routes found.'))
        } else {
          console.table(
            allRoutes.map((r) => ({
              Name: r.name,
              Endpoint: r.endpoint || 'N/A',
              Protocol: r.protocol,
              Source: r.source,
              Peer: 'peer' in r ? r.peer : '-',
            }))
          )
        }
        process.exit(0)
      } catch (error) {
        console.error(chalk.red(`[error] Error: ${error instanceof Error ? error.message : error}`))
        process.exit(1)
      }
    })

  route
    .command('delete')
    .description('Delete a local route')
    .argument('<name>', 'Route name to delete')
    .option('--token <token>', 'Auth token')
    .action(async (name, options, cmd) => {
      const globals = cmd.optsWithGlobals()
      const validation = DeleteRouteInputSchema.safeParse({
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

        const result = await mgmtScope.applyAction({
          resource: 'localRoute',
          resourceAction: 'delete',
          data: {
            name: validation.data.name,
          },
        })

        if (result.success) {
          console.log(chalk.green(`[ok] Route '${name}' deleted.`))
          process.exit(0)
        } else {
          console.error(chalk.red(`[error] Failed to delete route: ${result.error}`))
          process.exit(1)
        }
      } catch (error) {
        console.error(chalk.red(`[error] Error: ${error instanceof Error ? error.message : error}`))
        process.exit(1)
      }
    })

  return route
}
