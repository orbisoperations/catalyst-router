import { Command } from 'commander';
import { serviceCommands } from './commands/service.js';
import { metricsCommands } from './commands/metrics.js';
import { peerCommands } from './commands/peer.js';

const program = new Command();

program
    .name('catalyst')
    .description('Catalyst Node CLI')
    .version(process.env.VERSION || '0.0.0-dev')
    .option('--orchestrator-url <url>', 'Orchestrator RPC URL', process.env.CATALYST_ORCHESTRATOR_URL || 'ws://localhost:3000/rpc')
    .option('--log-level <level>', 'Log level', 'info');

program.addCommand(serviceCommands());
program.addCommand(metricsCommands());
program.addCommand(peerCommands());

program.parse(process.argv);
