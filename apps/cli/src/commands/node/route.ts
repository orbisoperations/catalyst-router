import { Command } from 'commander'
import chalk from 'chalk'
import {
  CreateRouteInputSchema,
  DeleteRouteInputSchema,
  ListRoutesInputSchema,
} from '../../types.js'
import {
  createRouteHandler,
  listRoutesHandler,
  deleteRouteHandler,
} from '../../handlers/node-route-handlers.js'

export function routeCommands(): Command {
  const route = new Command('route').description('Manage local routes')

  route
    .command('create')
    .description('Create a new local route')
    .argument('<name>', 'Route name')
    .argument('<endpoint>', 'Service endpoint URL')
    .option(
      '-p, --protocol <protocol>',
      'Protocol (http, http:graphql, http:gql, http:grpc, tcp)',
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
        const result = await createRouteHandler(validation.data)

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
        const result = await listRoutesHandler(validation.data)

        if (result.success) {
          if (result.data.routes.length === 0) {
            console.log(chalk.yellow('No routes found.'))
          } else {
            console.table(
              result.data.routes.map((r) => ({
                Name: r.name,
                Endpoint: r.endpoint || 'N/A',
                Protocol: r.protocol,
                Source: r.source,
                Peer: r.source === 'internal' ? r.peer.name : '-',
              }))
            )
          }
          process.exit(0)
        } else {
          console.error(chalk.red(`[error] Failed to list routes: ${result.error}`))
          process.exit(1)
        }
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
        const result = await deleteRouteHandler(validation.data)

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
