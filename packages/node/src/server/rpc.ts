// Mocking capnweb usage for now as we set up the structure.
// In a real implementation we would import { RpcServer } from 'capnweb';

// Defining the Interface locally for now to avoid circular deps until we refactor
export interface PeerState {
    peerId: string;
    asn: number;
    status: 'CONNECTING' | 'ESTABLISHED' | 'IDLE';
}

export interface Route {
    prefix: string;
    nextHop: string;
    origin: number;
}

export interface CatalystRpc {
    getPeers(): Promise<PeerState[]>;
    getRoutes(): Promise<Route[]>;
    shutdown(): Promise<void>;
}

export class CatalystRpcServer implements CatalystRpc {
    async getPeers(): Promise<PeerState[]> {
        // In a real app, this would fetch from the PeeringManager
        return [
            { peerId: '192.168.1.5', asn: 65005, status: 'ESTABLISHED' }
        ];
    }

    async getRoutes(): Promise<Route[]> {
        // In a real app, this would fetch from the RIB
        return [
            { prefix: '10.0.0.0/24', nextHop: '192.168.1.5', origin: 65005 }
        ];
    }

    async shutdown(): Promise<void> {
        console.log('Shutdown requested via RPC...');
        process.exit(0);
    }
}
