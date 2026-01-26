import { Command } from 'commander';
import { queryCommand } from './query.js';
import { pingCommand } from './ping.js';
import { traceCommand } from './trace.js';

export function dataCommands() {
    const data = new Command('data')
        .description('Data plane commands for interacting with services');

    data.addCommand(queryCommand());
    data.addCommand(pingCommand());
    data.addCommand(traceCommand());

    return data;
}
