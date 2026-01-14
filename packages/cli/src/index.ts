import { Command } from 'commander';
import chalk from 'chalk';
import { serviceCommands } from './commands/service.js';
import { metricsCommands } from './commands/metrics.js';
import { peerCommands } from './commands/peer.js';

const program = new Command();

program
    .name('catalyst')
    .description('Catalyst Node CLI')
<<<<<<< HEAD
    .version(process.env.VERSION || '0.0.0-dev')
    .option('--orchestrator-url <url>', 'Orchestrator RPC URL', 'ws://localhost:3000/rpc')
    .option('--log-level <level>', 'Log level', 'info');
=======
    .version('0.0.1')
    .option('-u, --orchestrator-url <url>', 'Orchestrator URL', 'http://localhost:3000');
>>>>>>> cc06185 (chore: peer to peer updates)

program.addCommand(serviceCommands());
program.addCommand(metricsCommands());
program.addCommand(peerCommands());

program.parse(process.argv);
