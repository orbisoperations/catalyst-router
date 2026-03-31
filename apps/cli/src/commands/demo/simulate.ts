import { Command } from 'commander'
import chalk from 'chalk'
import { hackathonScenario } from '../../simulator/scenarios/hackathon.js'
import { runScenario } from '../../simulator/runner.js'

export function simulateCommand(): Command {
  return new Command('simulate')
    .description('Run a simulated scenario against the live orchestrator')
    .option('--speed <multiplier>', 'Speed multiplier (e.g., 5 = 5x faster)', '5')
    .option('--scenario <name>', 'Scenario to run', 'hackathon')
    .option('--token <token>', 'Auth token')
    .action(async (options, cmd) => {
      // Walk up: simulate → demo → program (root)
      const rootOpts = cmd.parent?.parent?.opts() ?? {}
      const token = options.token || rootOpts.token || process.env.CATALYST_AUTH_TOKEN || ''
      const orchestratorUrl = rootOpts.orchestratorUrl

      if (!token) {
        console.error(chalk.red('[error] --token or CATALYST_TOKEN env var is required'))
        process.exit(1)
      }

      const speed = Number(options.speed)
      if (!Number.isFinite(speed) || speed <= 0) {
        console.error(chalk.red('[error] --speed must be a positive number'))
        process.exit(1)
      }

      const scenarios: Record<string, typeof hackathonScenario> = {
        hackathon: hackathonScenario,
      }

      const scenario = scenarios[options.scenario]
      if (!scenario) {
        console.error(chalk.red(`[error] Unknown scenario: ${options.scenario}`))
        console.error(chalk.dim(`Available: ${Object.keys(scenarios).join(', ')}`))
        process.exit(1)
      }

      try {
        await runScenario(scenario, {
          speed,
          ctx: { orchestratorUrl, token },
        })
      } catch (error) {
        console.error(chalk.red(`[error] ${error instanceof Error ? error.message : error}`))
        process.exit(1)
      }
    })
}
