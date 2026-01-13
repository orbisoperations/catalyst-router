# Catalyst Node

**Catalyst Node** is a distributed control and data plane designed to bridge organizations, clouds, and disparate fabrics. It enables different organizations to "peer" and offer services to each other in a cloud-native, edge-compatible way.

Modeled after BGP, Catalyst Node brings decentralized routing to Layers 4-7, allowing for service discovery and traffic propagation across trust boundaries without relying on centralized coordination like a single Kubernetes cluster or mesh.

## Mission

Traditional service meshes (like Istio/Linkerd) excel at managing traffic *within* a cluster or organization. Catalyst Node is built for the spaces *between* them. We aim to:

*   **Bridge Disparate Networks**: Connect on-prem datacenters, public clouds, and edge devices (even Raspberry Pis) into a unified service fabric.
*   **Enable Organizational Peering**: Allow Organization A to securely expose specific services to Organization B via standard peering agreements, similar to how ISPs peer on the internet.
*   **Run Anywhere**: Minimal resource footprint, suitable for small compute devices.

## Core Architecture

Catalyst Node runs as a **Core Pod** containing 5 specialized containers:

### 1. Control Plane (The Orchestrator)
The "brain" of the node.
*   **Function**: Handles BGP peering, xDS configuration generation, and sidecar management.
*   **Transport**: Uses `capnweb` RPC to coordinate with sidecars and other nodes.

### 2. Data Plane (Envoy Proxy)
The "muscle" of the node.
*   **Function**: High-performance edge router terminating TLS.
*   **Operation**: Configured dynamically via **xDS** (REST) by the Orchestrator.

### 3. Sidecars (Specialized Functions)
*   **GraphQL Gateway**: TypeScript-based federation engine.
*   **Auth Service**: Handles Key signing and JWKS.
*   **OTEL Collector**: Central metrics sink for the pod.

## Key Features

*   **Decentralized**: No single point of failure or control.
*   **Plugin-Driven**: Extensible architecture for defining custom behaviors for routing, local services, and propagation.
*   **Local Services**: Easily spin up and advertise local resources (e.g., VPN clients, GraphQL federations) as network services.

## Protocol Support

We support a variety of protocols for service definitions. Currently, **GraphQL** receives first-class support for federation.

| Protocol | Status | Notes |
| :--- | :--- | :--- |
| `tcp` | ✅ Stabilized | Generic TCP tunneling |
| `udp` | ✅ Stabilized | Generic UDP tunneling |
| `http` | 🚧 Beta | Generic HTTP proxying |
| `http:graphql` | ✅ Live | Fully federated GraphQL support |
| `http:gql` | ✅ Live | Alias for `http:graphql` |
| `http:grpc` | 🗓️ Planned | gRPC transcoding and routing |

