#!/usr/bin/env bun
import { Command } from 'commander'
import { serviceCommands } from './commands/service.js'
import { metricsCommands } from './commands/metrics.js'
import { serviceTokenCommands } from './commands/service-token.js'

const program = new Command()

program.name('catalyst').description('Catalyst Node CLI').version('0.0.1')

program.addCommand(serviceCommands())
program.addCommand(metricsCommands())
program.addCommand(serviceTokenCommands())

program.parse(process.argv)
