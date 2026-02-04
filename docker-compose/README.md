# Docker Compose Examples

## M0P2 Example with Auth Integration

The `example.m0p2.compose.yaml` demonstrates a complete Catalyst setup with authentication:

### Services

- **auth**: Authentication service handling JWTs, key rotation, and Cedar-based authorization
- **orchestrator**: Control plane orchestrator with token-based authentication
- **gateway**: GraphQL federation gateway
- **books-service**: Example GraphQL service
- **movies-service**: Example GraphQL service

### Setup Instructions

#### 1. Start the auth service first

```bash
docker compose -f docker-compose/example.m0p2.compose.yaml up auth
```

#### 2. Extract the system admin token

The auth service generates a system admin token on startup and logs it. Watch the logs for:

```
System token: eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6Ii4uLiJ9...
```

Copy this token.

#### 3. Set the system token environment variable

```bash
export CATALYST_SYSTEM_TOKEN="<paste token here>"
```

#### 4. Start remaining services

```bash
docker compose -f docker-compose/example.m0p2.compose.yaml up
```

### How It Works

1. **Auth Service Startup**: The auth service starts and mints a system admin token using the bootstrap token
2. **Token Handoff**: The orchestrator receives the system token via `CATALYST_SYSTEM_TOKEN` environment variable
3. **Node Token Minting**: On startup, the orchestrator uses the system token to mint a NODE token for itself
4. **Token Validation**: All incoming requests to the orchestrator are validated via the auth service's permissions API

### Development Notes

- The bootstrap token is set to `dev-bootstrap-token` for development
- Auth data (keys and tokens) is persisted in a Docker volume named `auth-data`
- The auth service must be healthy before the orchestrator starts (health check dependency)

### Token-Based Authentication Flow

1. Caller provides token to `getIBGPClient()`, `getNetworkClient()`, or `getDataChannelClient()`
2. Orchestrator calls auth service `permissions(callerToken)` to validate token
3. Auth service validates token and checks Cedar policies for requested action
4. If authorized, orchestrator returns the requested client
5. Client method calls are dispatched without additional auth checks (already validated)

### Bypassing Auth (Testing Only)

For unit tests, you can bypass auth validation by setting:

```bash
export CATALYST_SKIP_AUTH=true
```

**WARNING**: Never use this in production!
