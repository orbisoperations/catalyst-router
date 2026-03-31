import { Command } from 'commander'
import { simulateCommand } from './simulate.js'

export function demoCommands(): Command {
  const demo = new Command('demo').description('Demo and simulation tools')

  demo.addCommand(simulateCommand())

  return demo
}
