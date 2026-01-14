import { Command } from 'commander';
import { createClient } from '../client.js';
import chalk from 'chalk';

type CliResult<T> = { success: true; data?: T } | { success: false; error: string };

type AddServiceParams = {
    name: string;
    endpoint: string;
    protocol: string;
};

export async function addService(params: AddServiceParams): Promise<CliResult<void>> {
    try {
        const root = await createClient() as any;

        const action = {
            resource: 'create-datachannel:local-routing',
            data: params
        };

        const result = await root.applyAction(action);

        if (result.success) {
            return { success: true };
        } else {
            return { success: false, error: result.error || 'Unknown server error' };
        }
    } catch (err: any) {
        return { success: false, error: err.message || 'Connection error' };
    }
}

export async function listServices(): Promise<CliResult<any[]>> {
    try {
        const root = await createClient() as any;
        const result = await root.listLocalRoutes();
        return { success: true, data: result.routes || [] };
    } catch (err: any) {
        return { success: false, error: err.message || 'Connection error' };
    }
}

export function serviceCommands() {
    const service = new Command('service').description('Manage services');

    service
        .command('add')
        .description('Register a new service')
        .argument('<name>', 'Service name')
        .argument('<endpoint>', 'Service endpoint URL')
        .option('-p, --protocol <protocol>', 'Service protocol', 'tcp:graphql')
        .action(async (name, endpoint, options) => {
            const result = await addService({ name, endpoint, protocol: options.protocol });

            if (result.success) {
                console.log(chalk.green(`Service '${name}' added successfully.`));
            } else {
                console.error(chalk.red(`Failed to add service:`), result.error);
                process.exit(1);
            }
        });

    service
        .command('list')
        .description('List all registered services')
        .action(async () => {
            const result = await listServices();

            if (!result.success) {
                console.error(chalk.red('Error listing services:'), result.error);
                process.exit(1);
            }

            if (result.data && result.data.length > 0) {
                console.table(result.data);
            } else {
                console.log(chalk.yellow('No services found.'));
            }
        });

    return service;
}
