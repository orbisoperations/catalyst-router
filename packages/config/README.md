# @catalyst/config

Centralized configuration management for the Catalyst Node system.

## Environment Variables

| Variable                            | Config Path                              | Description                                  | Default        |
| ----------------------------------- | ---------------------------------------- | -------------------------------------------- | -------------- |
| `PORT`                              | `port`                                   | The port the service will listen on          | `3000`         |
| `CATALYST_NODE_ID`                  | `node.name`                              | **Required.** FQDN of the node               | -              |
| `CATALYST_PEERING_ENDPOINT`         | `node.endpoint`                          | **Required.** Reachable endpoint for peering | -              |
| `CATALYST_DOMAINS`                  | `node.domains`                           | Comma-separated list of managed domains      | `[]`           |
| `CATALYST_PEERING_SECRET`           | `orchestrator.ibgp.secret`               | Secret for iBGP peering                      | `valid-secret` |
| `CATALYST_GQL_GATEWAY_ENDPOINT`     | `orchestrator.gqlGatewayConfig.endpoint` | GraphQL Gateway endpoint                     | -              |
| `CATALYST_AUTH_KEYS_DB`             | `auth.keysDb`                            | SQLite DB for keys                           | `keys.db`      |
| `CATALYST_AUTH_TOKENS_DB`           | `auth.tokensDb`                          | SQLite DB for tokens                         | `tokens.db`    |
| `CATALYST_AUTH_REVOCATION`          | `auth.revocation.enabled`                | Enable token revocation (`true`/`false`)     | `false`        |
| `CATALYST_AUTH_REVOCATION_MAX_SIZE` | `auth.revocation.maxSize`                | Max size for revocation store                | -              |
| `CATALYST_BOOTSTRAP_TOKEN`          | `auth.bootstrap.token`                   | Pre-defined bootstrap token                  | -              |
| `CATALYST_BOOTSTRAP_TTL`            | `auth.bootstrap.ttl`                     | TTL for bootstrap token in ms                | `86400000`     |

## Usage

```typescript
import { loadDefaultConfig } from '@catalyst/config'

const config = loadDefaultConfig()
console.log(`Starting node ${config.node.name} on port ${config.port}`)
```
