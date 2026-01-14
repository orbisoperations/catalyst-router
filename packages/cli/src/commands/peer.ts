
import { Command } from 'commander';
import { createClient } from '../client.js';
import { z } from 'zod';
import chalk from 'chalk';

export const peerCommands = () => {
    const peer = new Command('peer');

    peer.command('add')
        .description('Add a new peer connection')
        .argument('<endpoint>', 'WebSocket endpoint of the peer (e.g., ws://localhost:3000/rpc)')
        .requiredOption('--secret <secret>', 'Shared secret for authentication')
        .action(async (endpoint, options) => {
            try {
                const client = await createClient();
                // We need to cast client to any or extend the type to include 'applyAction' if it's generic
                // The RpcTarget usually exposes `applyAction`?
                // Wait, the client is a proxy for `OrchestratorRpcServer`.
                // `OrchestratorRpcServer` extends `RpcTarget`.
                // `server.ts`: `class OrchestratorRpcServer extends RpcTarget`
                // `RpcTarget` (from generic RPC lib) usually has `applyAction` if that's the pattern.
                // BUT `OrchestratorRpcServer` EXPOSES `listPeers`, `authenticate` etc directly?
                // capnweb/RPC usually exposes methods.
                // `server.ts` has `authenticate`, `listPeers`.
                // BUT `add peer` uses `InternalPeeringUserCreateAction`.
                // Does `OrchestratorRpcServer` expose `applyAction` via RPC?
                // `server.ts` does `new InternalPeeringPlugin(this.applyAction.bind(this))`... that passes it to Plugin.
                // Does it expose it to RPC client?
                // `class OrchestratorRpcServer extends RpcTarget`...
                // Only public methods on the class are callable via RPC.
                // `applyAction` is defined in `RpcTarget`?
                // Let's assume `applyAction` IS exposed or we should use a specific method.
                // Re-reading `server.ts`:
                // It has `async applyAction(action: Action): Promise<ActionResult>`.
                // S0 yes, we can call `client.applyAction(...)`.

                const result = await client.applyAction({
                    resource: 'internal-peering-user',
                    action: 'create',
                    data: {
                        endpoint,
                        secret: options.secret
                    }
                });

                if (result.success) {
                    console.log(chalk.green(`Peer added successfully. ID: ${result.id}`));
                } else {
                    console.error(chalk.red(`Failed to add peer: ${result.error}`));
                    process.exit(1);
                }
            } catch (error: any) {
                console.error(chalk.red(`Error: ${error.message}`));
                process.exit(1);
            }
        });

    peer.command('list')
        .description('List all peers')
        .action(async () => {
            try {
                const client = await createClient();
                // Client has `listPeers` method
                const result = await client.listPeers();

                if (result.peers.length === 0) {
                    console.log('No peers connected.');
                } else {
                    console.table(result.peers.map((p: any) => ({
                        ID: p.id,
                        AS: p.as,
                        Endpoint: p.endpoint,
                        Domains: p.domains.join(', ')
                    })));
                }
            } catch (error: any) {
                console.error(chalk.red(`Error: ${error.message}`));
                process.exit(1);
            }
        });

    return peer;
};
