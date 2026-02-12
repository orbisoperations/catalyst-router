# @catalyst/config

Centralized configuration management for the Catalyst Router system.

## Environment Variables

| Variable                            | Config Path                              | Description                                  | Default        |
| ----------------------------------- | ---------------------------------------- | -------------------------------------------- | -------------- |
| `PORT`                              | `port`                                   | The port the service will listen on          | `3000`         |
| `CATALYST_NODE_ID`                  | `node.name`                              | **Required.** Short node identifier          | -              |
| `CATALYST_PEERING_ENDPOINT`         | `node.endpoint`                          | **Required.** Reachable endpoint for peering | -              |
| `CATALYST_ORG_DOMAIN`               | `node.domain`                            | Organization domain for FQDN construction    | `''`           |
| `CATALYST_PEERING_SECRET`           | `orchestrator.ibgp.secret`               | Secret for iBGP peering                      | `valid-secret` |
| `CATALYST_GQL_GATEWAY_ENDPOINT`     | `orchestrator.gqlGatewayConfig.endpoint` | GraphQL Gateway endpoint                     | -              |
| `CATALYST_AUTH_KEYS_DB`             | `auth.keysDb`                            | SQLite DB for keys                           | `keys.db`      |
| `CATALYST_AUTH_TOKENS_DB`           | `auth.tokensDb`                          | SQLite DB for tokens                         | `tokens.db`    |
| `CATALYST_AUTH_REVOCATION`          | `auth.revocation.enabled`                | Enable token revocation (`true`/`false`)     | `false`        |
| `CATALYST_AUTH_REVOCATION_MAX_SIZE` | `auth.revocation.maxSize`                | Max size for revocation store                | -              |
| `CATALYST_BOOTSTRAP_TOKEN`          | `auth.bootstrap.token`                   | Pre-defined bootstrap token                  | -              |
| `CATALYST_BOOTSTRAP_TTL`            | `auth.bootstrap.ttl`                     | TTL for bootstrap token in ms                | `86400000`     |

## FQDN Construction

When `CATALYST_ORG_DOMAIN` is set, `loadDefaultConfig()` constructs the node's fully-qualified domain name as `{CATALYST_NODE_ID}.{CATALYST_ORG_DOMAIN}` and stores it in `config.node.name`. Data channel FQDNs follow the pattern `{channel}.{nodeId}.{orgDomain}`.

```
CATALYST_NODE_ID=node-a  +  CATALYST_ORG_DOMAIN=example.local
                         |
                         v
              config.node.name = "node-a.example.local"

Data channel "books" -> "books.node-a.example.local"
```

If `CATALYST_ORG_DOMAIN` is not set, `config.node.name` equals `CATALYST_NODE_ID` as-is.

## Usage

```typescript
import { loadDefaultConfig } from '@catalyst/config'

const config = loadDefaultConfig()
// config.node.name is the full FQDN (e.g., "node-a.example.local")
// config.node.domain is the org domain (e.g., "example.local")
console.log(`Starting node ${config.node.name} on port ${config.port}`)
```
