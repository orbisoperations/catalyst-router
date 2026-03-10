import { Command } from 'commander'
import chalk from 'chalk'
import { ListRelaysInputSchema } from '../../types.js'
import { listRelaysHandler } from '../../handlers/video-relay-handlers.js'

export function relayCommands(): Command {
  const relay = new Command('relay').description('Manage video relay sessions')

  relay
    .command('list')
    .description('List active relay sessions')
    .option('--token <token>', 'Auth token')
    .action(async (options, cmd) => {
      const globals = cmd.optsWithGlobals()
      const validation = ListRelaysInputSchema.safeParse({
        token: options.token || globals.token || process.env.CATALYST_AUTH_TOKEN,
        videoUrl: globals.videoUrl,
      })

      if (!validation.success) {
        console.error(chalk.red('Invalid input:'))
        validation.error.issues.forEach((issue) => {
          console.error(chalk.yellow(`- ${issue.path.join('.')}: ${issue.message}`))
        })
        process.exit(1)
      }

      const result = await listRelaysHandler(validation.data)

      if (result.success && !result.data.available) {
        console.log(
          chalk.yellow(
            'Relay listing is not yet available. The video service does not currently expose relay session data.'
          )
        )
        process.exit(0)
      }
    })

  return relay
}
