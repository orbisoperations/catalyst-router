import { Command } from 'commander';
import { createClient } from '../../client.js';
import chalk from 'chalk';
import type { CliResult } from '../../types.js';



export async function fetchMetrics(): Promise<CliResult<unknown>> {
    try {
        const root = await createClient();
        const result = await root.connectionFromManagementSDK().listMetrics();
        return { success: true, data: result };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: message || 'Unknown error' };
    }
}

export function metricsCommands() {
    const metrics = new Command('metrics')
        .description('View metrics')
        .action(async () => {
            const result = await fetchMetrics();

            if (!result.success) {
                console.error(chalk.red('Error fetching metrics:'), result.error);
                process.exit(1);
            }

            console.log(JSON.stringify(result.data, null, 2));
            process.exit(0);
        });

    return metrics;
}
