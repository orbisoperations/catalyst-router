import { ConnectionPool, type CatalystNodeBus, type PublicApi } from '../src/orchestrator.js'
import type { RpcStub } from 'capnweb'

export class MockConnectionPool extends ConnectionPool {
  private nodes = new Map<string, CatalystNodeBus>()
  private offlineNodes = new Set<string>()

  constructor() {
    super('ws')
  }

  registerNode(bus: CatalystNodeBus) {
    // Use type casting to access internal config for test discovery
    const nameStr = (bus as unknown as { config: { node: { name: string } } }).config.node.name
    this.nodes.set(nameStr, bus)
  }

  setOffline(nodeName: string): void {
    this.offlineNodes.add(nodeName)
  }

  setOnline(nodeName: string): void {
    this.offlineNodes.delete(nodeName)
  }

  override get(endpoint: string) {
    // Map ws://node-a to node-a.somebiz.local.io etc
    const targetNode = Array.from(this.nodes.values()).find((bus) => {
      const nodeInfo = (bus as unknown as { config: { node: { name: string } } }).config.node
      return endpoint.includes(nodeInfo.name.split('.')[0]) || endpoint.includes(nodeInfo.name)
    })

    const isOffline =
      targetNode &&
      this.offlineNodes.has(
        (targetNode as unknown as { config: { node: { name: string } } }).config.node.name
      )

    return {
      getIBGPClient: async (token: string) => {
        if (!targetNode || isOffline) return { success: false, error: 'Node not found' }
        return targetNode.publicApi().getIBGPClient(token)
      },
      updateConfig: async () => ({ success: true }),
    } as unknown as RpcStub<PublicApi>
  }
}
