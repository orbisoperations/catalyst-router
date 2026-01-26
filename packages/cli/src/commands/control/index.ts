import { Command } from 'commander';
import { serviceCommands } from './service.js';
import { peerCommands } from './peer.js';
import { metricsCommands } from './metrics.js';

export function controlCommands() {
    const control = new Command('control')
        .description('Control plane commands for managing the Catalyst mesh');

    control.addCommand(serviceCommands());
    control.addCommand(peerCommands());
    control.addCommand(metricsCommands());

    return control;
}
