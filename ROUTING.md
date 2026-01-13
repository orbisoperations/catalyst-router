# Routing Table Structure

The Catalyst Routing Table is the central registry for all connectivity within the mesh. It tracks two primary types of entities: **Peers** (other nodes) and **Routes** (data channels/services).

## 1. Peers
Peers represent other Catalyst Nodes in the cluster.

### Schema
- **ID**: Unique identifier for the peer (typically `tcp://<hostname>:<port>`).
- **AS**: Autonomous System number. Peers must match the local AS to exchange routes.
- **Domains**: A list of service domains (e.g., `us-west.svc`, `payments.svc`) that this peer is responsible for.
- **Endpoint**: The control plane address for RPC communication.

### Example
```json
{
  "id": "tcp://node-b:4015",
  "as": 100,
  "domains": ["us-west.svc"],
  "endpoint": "ws://node-b:4015/rpc"
}
```

## 2. Data Channels (Routes)
Data channels represent specific services available within the mesh. These can be:
- **Internal**: Hosted by the local node.
- **Proxied**: Forwarded to another destination (e.g., an external API or database).
- **External**: Learned from a remote peer via the peering protocol.

### Schema
- **FQDN**: The logical Fully Qualified Domain Name used for service discovery (e.g., `auth.internal`, `db.production`). This is the primary index for the routing table.
- **Name**: A human-readable label for the service.
- **Protocol**: The protocol used by the service (e.g., `tcp:http`, `tcp:graphql`, `udp`).
- **Endpoint**: The physical address where the traffic should be sent (e.g., `http://localhost:3000`).
- **Region** (Optional): Locality information.

### Example
```json
{
  "fqdn": "auth.internal",
  "name": "Auth Service",
  "protocol": "tcp:http",
  "endpoint": "http://localhost:3000",
  "region": "us-east"
}
```

## Lookup Logic
1. **Resolution**: When a request comes in for a specific FQDN (e.g., via the GraphQL Gateway or Envoy), the route table looks up the entry by `fqdn`.
2. **Routing**:
    - If the route is **Internal** or **Proxied**, traffic is handled locally or forwarded directly.
    - If the route is **External**, the Orchestrator determines which **Peer** advertised the domain matching the FQDN and forwards the request via the appropriate Data Channel to that peer.
