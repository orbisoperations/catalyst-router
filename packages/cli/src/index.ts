#!/usr/bin/env bun
import { Command } from 'commander';
import chalk from 'chalk';
import { serviceCommands } from './commands/service.js';
import { metricsCommands } from './commands/metrics.js';

const program = new Command();

program
    .name('catalyst')
    .description('Catalyst Node CLI')
    .version('0.0.1');

program.addCommand(serviceCommands());
program.addCommand(metricsCommands());

program.parse(process.argv);
