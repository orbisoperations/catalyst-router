import { Command } from 'commander'
import chalk from 'chalk'
import { GraphqlIdeInputSchema } from '../../types.js'
import { startGraphqlIdeHandler } from '../../handlers/graphql-ide-handlers.js'

export function ideCommand(): Command {
  const ide = new Command('ide')
    .description('Start GraphiQL IDE for debugging GraphQL queries')
    .option('-p, --port <port>', 'Local server port', '5173')
    .option('-e, --endpoint <url>', 'GraphQL endpoint URL', 'http://localhost:4000/graphql')
    .option('--no-open', "Don't auto-open browser")
    .action(async (options) => {
      const validation = GraphqlIdeInputSchema.safeParse({
        port: parseInt(options.port, 10),
        endpoint: options.endpoint,
        open: options.open,
      })

      if (!validation.success) {
        console.error(chalk.red('Invalid input:'))
        validation.error.issues.forEach((issue) => {
          console.error(chalk.yellow(`- ${issue.path.join('.')}: ${issue.message}`))
        })
        process.exit(1)
      }

      const result = await startGraphqlIdeHandler(validation.data)

      if (result.success) {
        console.log(chalk.green(`\n  GraphiQL IDE is running!\n`))
        console.log(`  ${chalk.cyan('Local:')}    ${result.data.url}`)
        console.log(`  ${chalk.cyan('Endpoint:')} ${validation.data.endpoint}\n`)
        console.log(chalk.gray('  Press Ctrl+C to stop\n'))

        // Handle graceful shutdown
        const shutdown = () => {
          console.log(chalk.yellow('\n  Shutting down...\n'))
          result.data.server.stop()
          process.exit(0)
        }

        process.on('SIGINT', shutdown)
        process.on('SIGTERM', shutdown)
      } else {
        console.error(chalk.red(`✗ Failed to start GraphiQL: ${result.error}`))
        process.exit(1)
      }
    })

  return ide
}
