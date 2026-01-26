import { Command } from 'commander';
import { createDataClient } from '../../data-client.js';
import chalk from 'chalk';
import { readFileSync } from 'fs';

export function queryCommand() {
    const query = new Command('query')
        .description('Execute a GraphQL query through the Gateway')
        .argument('<service>', 'Service name (currently not used, queries go to gateway)')
        .option('-q, --query <query>', 'GraphQL query string')
        .option('-f, --file <file>', 'Path to GraphQL query file')
        .option('-v, --variables <json>', 'Variables as JSON string')
        .option('--gateway-url <url>', 'Gateway URL', process.env.CATALYST_GATEWAY_URL || 'http://localhost:4000/graphql')
        .action(async (serviceName, options) => {
            try {
                // Get the query from either --query or --file
                let queryString: string;
                
                if (options.query) {
                    queryString = options.query;
                } else if (options.file) {
                    try {
                        queryString = readFileSync(options.file, 'utf-8');
                    } catch (err: unknown) {
                        const message = err instanceof Error ? err.message : String(err);
                        console.error(chalk.red('Failed to read query file:'), message);
                        process.exit(1);
                    }
                } else {
                    console.error(chalk.red('Error: Must provide either --query or --file'));
                    process.exit(1);
                }

                // Parse variables if provided
                let variables: Record<string, unknown> | undefined;
                if (options.variables) {
                    try {
                        variables = JSON.parse(options.variables);
                    } catch (err: unknown) {
                        console.error(chalk.red('Invalid JSON in --variables:'), err);
                        process.exit(1);
                    }
                }

                const client = createDataClient(options.gatewayUrl);
                const result = await client.query(queryString, variables);

                if (!result.success) {
                    console.error(chalk.red('Query failed:'), result.error);
                    process.exit(1);
                }

                // Pretty print the result
                console.log(chalk.green('Query successful!'));
                console.log(JSON.stringify(result.data, null, 2));
                process.exit(0);
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                console.error(chalk.red('Error:'), message);
                process.exit(1);
            }
        });

    return query;
}
