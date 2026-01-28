import { Command } from 'commander';
import chalk from 'chalk';
import { controlCommands } from './commands/control/index.js';
import { dataCommands } from './commands/data/index.js';
import { serviceCommands } from './commands/control/service.js';
import { peerCommands } from './commands/control/peer.js';
import { metricsCommands } from './commands/control/metrics.js';

const program = new Command();

program
    .name('catalyst')
    .description('Catalyst Node CLI')
    .version(process.env.VERSION || '0.0.0-dev')
    .option('--orchestrator-url <url>', 'Orchestrator RPC URL', process.env.CATALYST_ORCHESTRATOR_URL || 'ws://localhost:3000/rpc')
    .option('--gateway-url <url>', 'Gateway URL for data plane operations', process.env.CATALYST_GATEWAY_URL || 'http://localhost:4000/graphql')
    .option('--log-level <level>', 'Log level', 'info');

// Add new hierarchical commands
program.addCommand(controlCommands());
program.addCommand(dataCommands());

// Add backward compatibility with deprecation warnings
const deprecatedServiceCmd = serviceCommands();
deprecatedServiceCmd.hook('preAction', () => {
    console.warn(chalk.yellow('⚠ Warning: "catalyst service" is deprecated. Use "catalyst control service" instead.'));
    console.warn(chalk.yellow('   This command will be removed in a future version.\n'));
});
program.addCommand(deprecatedServiceCmd);

const deprecatedPeerCmd = peerCommands();
deprecatedPeerCmd.hook('preAction', () => {
    console.warn(chalk.yellow('⚠ Warning: "catalyst peer" is deprecated. Use "catalyst control peer" instead.'));
    console.warn(chalk.yellow('   This command will be removed in a future version.\n'));
});
program.addCommand(deprecatedPeerCmd);

const deprecatedMetricsCmd = metricsCommands();
deprecatedMetricsCmd.hook('preAction', () => {
    console.warn(chalk.yellow('⚠ Warning: "catalyst metrics" is deprecated. Use "catalyst control metrics" instead.'));
    console.warn(chalk.yellow('   This command will be removed in a future version.\n'));
});
program.addCommand(deprecatedMetricsCmd);

program.parse(process.argv);
