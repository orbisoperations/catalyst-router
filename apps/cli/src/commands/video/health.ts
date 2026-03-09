import { Command } from 'commander'
import chalk from 'chalk'
import { HealthCheckInputSchema } from '../../types.js'
import { healthCheckHandler } from '../../handlers/video-health-handlers.js'

export function healthCommand(): Command {
  const health = new Command('health')
    .description('Check video service health and readiness')
    .action(async (_options, cmd) => {
      const globals = cmd.optsWithGlobals()
      const validation = HealthCheckInputSchema.safeParse({
        videoUrl: globals.videoUrl,
      })

      if (!validation.success) {
        console.error(chalk.red('Invalid input:'))
        validation.error.issues.forEach((issue) => {
          console.error(chalk.yellow(`- ${issue.path.join('.')}: ${issue.message}`))
        })
        process.exit(1)
      }

      try {
        const result = await healthCheckHandler(validation.data)

        if (result.success) {
          console.log(`${chalk.cyan('Health:')}    ${chalk.green(result.data.status)}`)
          console.log(
            `${chalk.cyan('Readiness:')} ${result.data.ready ? chalk.green('ready') : chalk.yellow('not ready')}`
          )
          console.log(
            `${chalk.cyan('Catalog:')}   ${result.data.catalog ? chalk.green('synced') : chalk.yellow('not synced')}`
          )
          process.exit(0)
        } else {
          console.error(chalk.red(`[error] ${result.error}`))
          process.exit(1)
        }
      } catch (error) {
        console.error(chalk.red(`[error] Error: ${error instanceof Error ? error.message : error}`))
        process.exit(1)
      }
    })

  return health
}
