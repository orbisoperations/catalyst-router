
import { Command } from 'commander';
import { createClient } from '../../client.js';
import chalk from 'chalk';

export const peerCommands = () => {
    const peer = new Command('peer');

    peer.command('add')
        .description('Add a new peer connection')
        .argument('<endpoint>', 'WebSocket endpoint of the peer (e.g., ws://localhost:3000/rpc)')
        .requiredOption('--secret <secret>', 'Shared secret for authentication')
        .option('--domains <domains>', 'Comma-separated list of domains')
        .action(async (endpoint, options) => {
            try {
                const client = await createClient();

                const result = await client.connectionFromManagementSDK().applyAction({
                    resource: 'internalBGPConfig',
                    resourceAction: 'create',
                    data: {
                        endpoint,
                        domains: options.domains ? options.domains.split(',').map((d: string) => d.trim()) : []
                    }
                });

                if (result.success) {
                    // Extract ID from results if available (assuming first result has id)
                    const id = result.results?.[0]?.id || 'unknown';
                    console.log(chalk.green(`Peer added successfully. ID: ${id}`));
                    await new Promise(r => setTimeout(r, 100));
                    process.exit(0);
                } else {
                    console.error(chalk.red(`Failed to add peer: ${result.error}`));
                    process.exit(1);
                }
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                console.error(chalk.red(`Error: ${message}`));
                process.exit(1);
            }
        });

    peer.command('list')
        .description('List all peers')
        .action(async () => {
            try {
                const client = await createClient();
                const result = await client.connectionFromManagementSDK().listPeers();

                if (result.peers.length === 0) {
                    console.log('No peers connected.');
                } else {
                    console.table(result.peers.map((p: unknown) => {
                        const peer = p as { id: string; as: number; endpoint: string; domains: string[] };
                        return {
                            ID: peer.id,
                            AS: peer.as,
                            Endpoint: peer.endpoint,
                            Domains: peer.domains.join(', ')
                        };
                    }));
                }
                await new Promise(r => setTimeout(r, 100));
                process.exit(0);
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                console.error(chalk.red(`Error: ${message}`));
                process.exit(1);
            }
        });

    peer.command('remove')
        .description('Remove a peer connection')
        .argument('<peerId>', 'ID of the peer to remove')
        .action(async (peerId) => {
            try {
                const client = await createClient();
                const result = await client.connectionFromManagementSDK().deletePeer(peerId);
                if (result.success) {
                    console.log(chalk.green(`Peer ${peerId} removed.`));
                    process.exit(0);
                } else {
                    console.error(chalk.red(`Failed to remove peer: ${result.error}`));
                    process.exit(1);
                }
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                console.error(chalk.red(`Error: ${message}`));
                process.exit(1);
            }
        });

    return peer;
};
