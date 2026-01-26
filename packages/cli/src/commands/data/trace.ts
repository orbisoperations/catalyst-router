import { Command } from 'commander';
import { createDataClient } from '../../data-client.js';
import chalk from 'chalk';

export function traceCommand() {
    const trace = new Command('trace')
        .description('Trace request path through the mesh to a service')
        .argument('<service>', 'Service name to trace')
        .option('--gateway-url <url>', 'Gateway URL', process.env.CATALYST_GATEWAY_URL || 'http://localhost:4000/graphql')
        .action(async (serviceName, options) => {
            try {
                const client = createDataClient(options.gatewayUrl);
                
                console.log(chalk.blue(`Tracing route to service '${serviceName}'...`));
                console.log();

                const result = await client.trace(serviceName);

                if (!result.success) {
                    console.error(chalk.red('Trace failed:'), result.error);
                    process.exit(1);
                }

                if (result.data) {
                    const { hops, totalLatency } = result.data;
                    
                    console.log(chalk.green('Trace complete:'));
                    console.log();
                    
                    hops.forEach((hop, index) => {
                        console.log(
                            chalk.yellow(`${index + 1}.`),
                            chalk.cyan(hop.node),
                            chalk.gray(`${hop.latency}ms`),
                            chalk.gray(`(${hop.timestamp})`)
                        );
                    });
                    
                    console.log();
                    console.log(chalk.blue('Total latency:'), `${totalLatency}ms`);
                    console.log(chalk.blue('Hops:'), hops.length);
                }

                process.exit(0);
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                console.error(chalk.red('Error:'), message);
                process.exit(1);
            }
        });

    return trace;
}
