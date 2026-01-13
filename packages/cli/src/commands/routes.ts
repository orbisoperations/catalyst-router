
import { Command } from 'commander';
import { createClient } from '../client.js';
import chalk from 'chalk';

type CliResult<T> = { success: true; data?: T } | { success: false; error: string };

export async function listRoutes(): Promise<CliResult<any[]>> {
    try {
        const root = await createClient() as any;
        const result = await root.listLocalRoutes();
        return { success: true, data: result.routes || [] };
    } catch (err: any) {
        return { success: false, error: err.message || 'Connection error' };
    }
}

export function routeCommands() {
    const routes = new Command('routes').description('Manage routes');

    routes
        .command('list')
        .description('List all routes (internal and external)')
        .action(async () => {
            const result = await listRoutes();

            if (!result.success) {
                console.error(chalk.red('Error listing routes:'), result.error);
                process.exit(1);
            }

            if (result.data && result.data.length > 0) {
                // Simplify output for table
                const tableData = result.data.map((r: any) => ({
                    id: r.id,
                    fqdn: r.service?.fqdn,
                    source: r.sourcePeerId || 'local',
                    endpoint: r.service?.endpoint
                }));
                console.table(tableData);
            } else {
                console.log(chalk.yellow('No routes found.'));
            }
            process.exit(0);
        });

    return routes;
}
