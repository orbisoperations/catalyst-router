#!/usr/bin/env bun
import { Command } from 'commander';
import chalk from 'chalk';
import { serviceCommands } from './commands/service.js';
import { metricsCommands } from './commands/metrics.js';
import { peerCommands } from './commands/peers.js';

const program = new Command();

program
    .name('catalyst')
    .description('Catalyst Node CLI')
    .version('0.0.1');

program.addCommand(serviceCommands());
program.addCommand(metricsCommands());
program.addCommand(peerCommands());

program.parse(process.argv);
