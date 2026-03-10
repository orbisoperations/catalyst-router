import { Command } from 'commander'
import chalk from 'chalk'

export function relayCommands(): Command {
  const relay = new Command('relay').description('Manage video relay sessions')

  relay
    .command('list')
    .description('List active relay sessions')
    .option('--token <token>', 'Auth token')
    .action(async () => {
      console.log(
        chalk.yellow(
          'Relay listing is not yet available. The video service does not currently expose relay session data.'
        )
      )
      process.exit(0)
    })

  return relay
}
