/**
 * Simulator runner — orchestrates a scenario against a live orchestrator.
 * Applies a speed multiplier to all pauses.
 */
import chalk from 'chalk'
import type { SimAction } from './scenarios/hackathon.js'
import {
  simCreatePeer,
  simDeletePeer,
  simCreateRoute,
  simDeleteRoute,
  type SimulatorContext,
} from './actions.js'

const ENGINEER_COLORS: Record<string, (s: string) => string> = {
  Eve: chalk.cyan,
  Marcus: chalk.yellow,
  Priya: chalk.magenta,
  Jake: chalk.green,
  Anika: chalk.blue,
}

function colorForEngineer(name: string): (s: string) => string {
  return ENGINEER_COLORS[name] ?? chalk.white
}

function timestamp(): string {
  return chalk.dim(new Date().toISOString().slice(11, 19))
}

export interface RunnerOpts {
  speed: number
  ctx: SimulatorContext
  onAction?: (action: SimAction, index: number, total: number) => void
}

export async function runScenario(
  scenario: { name: string; description: string; actions: SimAction[] },
  opts: RunnerOpts
): Promise<void> {
  const { speed, ctx } = opts
  const actions = scenario.actions
  const total = actions.filter((a) => a.type !== 'pause').length
  let actionIndex = 0

  console.log('')
  console.log(chalk.bold(`  Scenario: ${scenario.name}`))
  console.log(chalk.dim(`  ${scenario.description}`))
  console.log(chalk.dim(`  Speed: ${speed}x | ${total} actions | Ctrl-C to stop`))
  console.log('')

  for (const action of actions) {
    if (action.type === 'pause') {
      const delay = Math.max(100, (action.seconds * 1000) / speed)
      if (action.comment) {
        console.log(`${timestamp()} ${chalk.bold.white(action.comment)}`)
      }
      await sleep(delay)
      continue
    }

    actionIndex++
    const progress = chalk.dim(`[${actionIndex}/${total}]`)
    const color = colorForEngineer('engineer' in action ? action.engineer : '')

    if (opts.onAction) {
      opts.onAction(action, actionIndex, total)
    }

    switch (action.type) {
      case 'create-peer': {
        console.log(
          `${timestamp()} ${progress} ${color(`[${action.engineer}]`)} ${chalk.green('+')} peer ${chalk.bold(action.name)}  ${chalk.dim(action.comment)}`
        )
        const result = await simCreatePeer(ctx, action.name, action.endpoint, action.domains)
        if (!result.success) {
          console.log(
            `${timestamp()}         ${chalk.red('✗')} ${chalk.red(result.error ?? 'unknown error')}`
          )
        }
        break
      }
      case 'delete-peer': {
        console.log(
          `${timestamp()} ${progress} ${color(`[${action.engineer}]`)} ${chalk.red('-')} peer ${chalk.bold(action.name)}  ${chalk.dim(action.comment)}`
        )
        const result = await simDeletePeer(ctx, action.name)
        if (!result.success) {
          console.log(
            `${timestamp()}         ${chalk.red('✗')} ${chalk.red(result.error ?? 'unknown error')}`
          )
        }
        break
      }
      case 'create-route': {
        console.log(
          `${timestamp()} ${progress} ${color(`[${action.engineer}]`)} ${chalk.green('+')} route ${chalk.bold(action.name)} ${chalk.dim(`(${action.protocol ?? 'http:graphql'})`)}  ${chalk.dim(action.comment)}`
        )
        const result = await simCreateRoute(ctx, action.name, action.endpoint, action.protocol)
        if (!result.success) {
          console.log(
            `${timestamp()}         ${chalk.red('✗')} ${chalk.red(result.error ?? 'unknown error')}`
          )
        }
        break
      }
      case 'delete-route': {
        console.log(
          `${timestamp()} ${progress} ${color(`[${action.engineer}]`)} ${chalk.red('-')} route ${chalk.bold(action.name)}  ${chalk.dim(action.comment)}`
        )
        const result = await simDeleteRoute(ctx, action.name)
        if (!result.success) {
          console.log(
            `${timestamp()}         ${chalk.red('✗')} ${chalk.red(result.error ?? 'unknown error')}`
          )
        }
        break
      }
    }
  }

  console.log('')
  console.log(chalk.bold.green(`  ✓ Simulation complete — ${actionIndex} actions executed`))
  console.log('')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
