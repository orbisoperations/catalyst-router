import { Command } from 'commander';
import { createClient } from '../client.js';
import chalk from 'chalk';
import type { ServiceProtocol } from '@catalyst/orchestrator';
import type { CliResult } from '../types.js';



import { AddServiceInputSchema, ListServicesInputSchema, type AddServiceInput } from '../types.js';

export async function addService(params: AddServiceInput): Promise<CliResult<void>> {
    try {
<<<<<<< HEAD
        await using root = await createClient(params.orchestratorUrl);
=======
        const root = await createClient();
        const api = root.connectionFromCli();
>>>>>>> 9d03721 (chore: implements progressive api for cli)

        const action = {
            resource: 'localRoute',
            resourceAction: 'create',
            data: params
        };

        const result = await api.applyAction(action);

        if (result.success) {
            return { success: true };
        } else {
            return { success: false, error: result.error || 'Unknown server error' };
        }
    } catch (err: any) {
        return { success: false, error: err.message || 'Connection error' };
    }
}

export async function listServices(orchestratorUrl?: string): Promise<CliResult<any[]>> {
    try {
<<<<<<< HEAD
        await using root = await createClient(orchestratorUrl);
        const result = await root.listLocalRoutes();
=======
        const root = await createClient();
        const api = root.connectionFromCli();
        const result = await api.listLocalRoutes();
>>>>>>> 9d03721 (chore: implements progressive api for cli)
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
        .option('-p, --protocol <protocol>', 'Service protocol', 'http:graphql')
        .action(async (name, endpoint, options, cmd) => {
            const globals = cmd.optsWithGlobals();
            const input = {
                name,
                endpoint,
                protocol: options.protocol,
                orchestratorUrl: globals.orchestratorUrl,
                logLevel: globals.logLevel
            };
            const validation = AddServiceInputSchema.safeParse(input);

            if (!validation.success) {
                console.error(chalk.red('Invalid input:'));
                validation.error.issues.forEach((issue) => {
                    console.error(chalk.yellow(`- ${issue.path.join('.')}: ${issue.message}`));
                });
                process.exit(1);
            }

            const result = await addService(validation.data);

            if (result.success) {
                console.log(chalk.green(`Service '${name}' added successfully.`));
                process.exit(0);
            } else {
                console.error(chalk.red(`Failed to add service:`), result.error);
                process.exit(1);
            }
        });

    service
        .command('list')
        .description('List all registered services')
        .action(async (options, cmd) => {
            // list has no args, so first arg might be options if no args defined?
            // Command with no args: action(options, command)
            // But wait, if I defined arguments earlier? No.
            // Let's verify arguments for action with no args.
            // It is usually (options, command).
            const globals = (cmd || options).optsWithGlobals ? (cmd || options).optsWithGlobals() : options;
            // In commander v7+, action is (args..., options, command)
            // If no args, it is (options, command)

            const input = {
                orchestratorUrl: globals.orchestratorUrl,
                logLevel: globals.logLevel
            };

            const validation = ListServicesInputSchema.safeParse(input);
            if (!validation.success) {
                console.error(chalk.red('Invalid input:'));
                validation.error.issues.forEach((issue) => {
                    console.error(chalk.yellow(`- ${issue.path.join('.')}: ${issue.message}`));
                });
                process.exit(1);
            }

            const result = await listServices(validation.data.orchestratorUrl);

            if (!result.success) {
                console.error(chalk.red('Error listing services:'), result.error);
                process.exit(1);
            }

            if (result.data && result.data.length > 0) {
                console.table(result.data);
            } else {
                console.log(chalk.yellow('No services found.'));
            }
            process.exit(0);
        });

    return service;
}
