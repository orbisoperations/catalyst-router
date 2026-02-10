import { getLogger } from '@catalyst/telemetry'
import type { CatalystRpc } from '../server/rpc.js'

export class CatalystClient {
  private readonly logger = getLogger(['catalyst', 'node', 'client'])

  // Mock connect - in reality this would connect via HTTP/WebSocket/IPC to the server
  async connect(): Promise<CatalystRpc> {
    // Return a proxy or stub. For now, returning null to show structure.
    this.logger.info`Connecting to Catalyst Node RPC...`
    throw new Error('Not implemented: Transport layer for Client')
  }
}

export async function runCli() {
  new CatalystClient()
  // const rpc = await client.connect();
  // const peers = await rpc.getPeers();
  // console.log(peers);
}
