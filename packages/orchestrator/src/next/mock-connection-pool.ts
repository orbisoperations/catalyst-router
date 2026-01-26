import { CatalystNodeBus, ConnectionPool, type PublicApi } from './orchestrator.js'
import type { RpcStub } from 'capnweb'

export class MockConnectionPool extends ConnectionPool {
    private nodes = new Map<string, CatalystNodeBus>()

    constructor() {
        super('ws')
    }

    registerNode(bus: CatalystNodeBus) {
        // Use type casting to access internal config for test discovery
        const nameStr = (bus as unknown as { config: { node: { name: string } } }).config.node.name
        this.nodes.set(nameStr, bus)
    }

    override get(endpoint: string) {
        // Map ws://node-a to node-a.somebiz.local.io etc
        const targetNode = Array.from(this.nodes.values()).find((bus) => {
            const nodeInfo = (bus as unknown as { config: { node: { name: string } } }).config.node
            return endpoint.includes(nodeInfo.name.split('.')[0]) || endpoint.includes(nodeInfo.name)
        })

        return {
            getIBGPClient: async (token: string) => {
                if (!targetNode) return { success: false, error: 'Node not found' }
                return targetNode.publicApi().getIBGPClient(token)
            },
            updateConfig: async () => ({ success: true }),
        } as unknown as RpcStub<PublicApi>
    }
}
