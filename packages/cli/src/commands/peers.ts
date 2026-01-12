import { Command } from 'commander';
import { createClient } from '../client.js';
import chalk from 'chalk';

type CliResult<T> = { success: true; data?: T } | { success: false; error: string };

export async function addPeer(address: string, secret: string): Promise<CliResult<void>> {
    try {
        const root = await createClient() as any;

        const action = {
            resource: 'peer',
            action: 'create',
            data: { address, secret }
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

export async function listPeers(): Promise<CliResult<any[]>> {
    try {
        const root = await createClient() as any;
        const result = await root.listPeers();
        return { success: true, data: result.peers || [] };
    } catch (err: any) {
        return { success: false, error: err.message || 'Connection error' };
    }
}

export function peerCommands() {
    const peer = new Command('peer').description('Manage internal peering');

    peer
        .command('add')
        .description('Connect to a new peer')
        .argument('<address>', 'Peer address (e.g., 10.0.0.5:4015)')
        .option('-s, --secret <secret>', 'Peering secret', 'valid-secret')
        .action(async (address, options) => {
            const result = await addPeer(address, options.secret);

            if (result.success) {
                console.log(chalk.green(`Peer connection initiated to '${address}'.`));
            } else {
                console.error(chalk.red(`Failed to add peer:`), result.error);
                process.exit(1);
            }
        });

    peer
        .command('list')
        .description('List all connected peers')
        .action(async () => {
            const result = await listPeers();

            if (!result.success) {
                console.error(chalk.red('Error listing peers:'), result.error);
                process.exit(1);
            }

            if (result.data && result.data.length > 0) {
                console.table(result.data);
            } else {
                console.log(chalk.yellow('No peers connected.'));
            }
        });

    // Alias for 'peers list' if user types 'catalyst-node peers list' instead of 'peer list'
    // But usually we group under 'peer' or 'peers'.
    // The requirement was "catalystctl rooutes peers list" ?
    // "catalystctl rooutes peers list"
    // The user also said "catalystctl rooutes peers list" which might mean nested under routes?
    // But then "add ... cli commands around listing peers".
    // "catalystctl rooutes peers list" implies `routes` command has `peers` subcommand?
    // But `peer add` implies top level or under peer.
    // I'll stick to `peer` top level command for now as per `service` example.

    return peer;
}
