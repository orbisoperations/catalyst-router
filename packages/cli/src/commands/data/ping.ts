import { Command } from 'commander';
import { createDataClient } from '../../data-client.js';
import chalk from 'chalk';

export function pingCommand() {
    const ping = new Command('ping')
        .description('Test connectivity to a service through the Gateway')
        .argument('<service>', 'Service name to ping')
        .option('--gateway-url <url>', 'Gateway URL', process.env.CATALYST_GATEWAY_URL || 'http://localhost:4000/graphql')
        .option('-c, --count <count>', 'Number of ping attempts', '1')
        .action(async (serviceName, options) => {
            try {
                const client = createDataClient(options.gatewayUrl);
                const count = parseInt(options.count, 10);

                console.log(chalk.blue(`Pinging service '${serviceName}' through Gateway...`));
                console.log();

                const results = [];
                
                for (let i = 0; i < count; i++) {
                    const result = await client.ping(serviceName);
                    
                    if (result.success && result.data) {
                        const { latency, timestamp } = result.data;
                        console.log(
                            chalk.green(`✓ Ping ${i + 1}/${count}:`),
                            `latency=${latency}ms`,
                            chalk.gray(`time=${timestamp}`)
                        );
                        results.push(latency);
                    } else {
                        console.log(
                            chalk.red(`✗ Ping ${i + 1}/${count} failed:`),
                            result.error
                        );
                    }

                    // Wait 1 second between pings if doing multiple
                    if (i < count - 1) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                }

                // Calculate statistics
                if (results.length > 0) {
                    const avg = results.reduce((a, b) => a + b, 0) / results.length;
                    const min = Math.min(...results);
                    const max = Math.max(...results);
                    
                    console.log();
                    console.log(chalk.blue('Statistics:'));
                    console.log(`  ${results.length}/${count} successful`);
                    console.log(`  min/avg/max = ${min}/${avg.toFixed(2)}/${max}ms`);
                }

                process.exit(results.length > 0 ? 0 : 1);
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                console.error(chalk.red('Error:'), message);
                process.exit(1);
            }
        });

    return ping;
}
