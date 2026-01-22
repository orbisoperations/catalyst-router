import { Command } from 'commander';
import { createClient } from '../client.js';
import chalk from 'chalk';
import type { CliResult } from '../types.js';



export async function fetchMetrics(): Promise<CliResult<any>> {
    try {
        const root = await createClient();
        const api = await root.connectionFromManagementSDK();
        const result = await api.listMetrics();
        return { success: true, data: result };
    } catch (err: any) {
        return { success: false, error: err.message || 'Unknown error' };
    }
}

export function metricsCommands() {
    const metrics = new Command('metrics').description('View metrics');

    metrics
        .command('show')
        .description('Show current metrics')
        .action(async () => {
            const result = await fetchMetrics();

            if (!result.success) {
                console.error(chalk.red('Error fetching metrics:'), result.error);
                process.exit(1);
            }

            console.log(JSON.stringify(result.data, null, 2));
        });

    return metrics;
}
