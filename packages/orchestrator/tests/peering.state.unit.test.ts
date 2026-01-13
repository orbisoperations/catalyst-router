
import { describe, it, expect, mock } from 'bun:test';
import { RouteTable } from '../src/state/route-table.js';
import { Peer } from '../src/peering/peer.js';
import { PeerInfo } from '../src/rpc/schema/peering.js';

describe('Peering State Unit Tests', () => {
    const mockPeerInfo: PeerInfo = {
        id: 'peer-1',
        as: 100,
        endpoint: 'ws://remote:8080',
        domains: ['remote.internal']
    };

    it('should add a peer immutably', () => {
        const table1 = new RouteTable();
        const peer = new Peer('peer-1', mockPeerInfo);

        const { state: table2, peer: addedPeer } = table1.addPeer(peer);

        expect(table1.getPeers()).toHaveLength(0);
        expect(table2.getPeers()).toHaveLength(1);
        expect(addedPeer).toBe(peer);
        expect(table2.getPeers()[0]).toBe(peer);
    });

    it('should overwrite existing peer with same ID (base primitive behavior)', () => {
        const table1 = new RouteTable();
        const peer1 = new Peer('peer-1', mockPeerInfo);
        const { state: table2 } = table1.addPeer(peer1);

        const peer2 = new Peer('peer-1', { ...mockPeerInfo, as: 200 }); // Same ID
        const { state: table3 } = table2.addPeer(peer2);

        expect(table2.getPeers()[0]).toBe(peer1);
        expect(table3.getPeers()[0]).toBe(peer2);
        expect(table3.getPeers()).toHaveLength(1);
    });

    it('should remove a peer immutably', () => {
        const table1 = new RouteTable();
        const peer = new Peer('peer-1', mockPeerInfo);
        const { state: table2 } = table1.addPeer(peer);

        const table3 = table2.removePeer('peer-1');

        expect(table2.getPeers()).toHaveLength(1);
        expect(table3.getPeers()).toHaveLength(0);
    });

    it('should disconnect peer when removing', () => {
        const table1 = new RouteTable();
        const peer = new Peer('peer-1', mockPeerInfo);

        let disconnected = false;
        peer.disconnect = async () => { disconnected = true; };

        const { state: table2 } = table1.addPeer(peer);
        table2.removePeer('peer-1');

        expect(disconnected).toBe(true);
    });
});
