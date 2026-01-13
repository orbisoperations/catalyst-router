# Catalyst Node

**Catalyst Node** is a distributed control and data plane designed to bridge organizations, clouds, and disparate fabrics. It enables different organizations to "peer" and offer services to each other in a cloud-native, edge-compatible way.

Modeled after BGP, Catalyst Node brings decentralized routing to Layers 4-7, allowing for service discovery and traffic propagation across trust boundaries without relying on centralized coordination like a single Kubernetes cluster or mesh.

## Mission

Traditional service meshes (like Istio/Linkerd) excel at managing traffic *within* a cluster or organization. Catalyst Node is built for the spaces *between* them. We aim to:

*   **Bridge Disparate Networks**: Connect on-prem datacenters, public clouds, and edge devices (even Raspberry Pis) into a unified service fabric.
*   **Enable Organizational Peering**: Allow Organization A to securely expose specific services to Organization B via standard peering agreements, similar to how ISPs peer on the internet.
*   **Run Anywhere**: Minimal resource footprint, suitable for small compute devices.

## Core Architecture

Catalyst Node consists of two primary components operating in tandem:

### 1. Control Plane (The Router)
The "brain" of the node.
*   **Function**: Handles service discovery, peering, and route propagation.
*   **Model**: Acts like a BGP router for application services. It builds routing tables based on advertisements from peers and local configurations.
*   **Transport**: Uses efficient, websocket-based RPC (`capnweb`) for communicating updates with other nodes.

### 2. Data Plane (The Gateway)
The "muscle" of the node.
*   **Function**: Handles actual network traffic transport.
*   **Engine**: Powered by **Envoy Proxy**.
*   **Operation**: dynamically configured by the Control Plane based on the current routing table.

## Key Features

*   **Decentralized**: No single point of failure or control.
*   **Plugin-Driven**: Extensible architecture for defining custom behaviors for routing, local services, and propagation.
*   **Local Services**: Easily spin up and advertise local resources (e.g., VPN clients, GraphQL federations) as network services.
