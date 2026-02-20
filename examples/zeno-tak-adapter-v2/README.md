# Zeno TAK Adapter v2

## TLDR

Bidirectional bridge between [Eclipse Zenoh](https://zenoh.io/) pub/sub and a [TAK Server](https://tak.gov/). Zenoh messages are transformed into Cursor on Target (CoT) events and forwarded to TAK (consumer mode), while TAK CoT events can be published back to Zenoh as raw XML (producer mode). Built with [Bun](https://bun.sh/), deployable as a Docker container or on [Fly.io](https://fly.io/).

## Table of Contents

- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Configuration Reference](#configuration-reference)
- [Built-in Transforms](#built-in-transforms)
- [Local Development](docs/local-development.md)
- [Docker](docs/docker.md)
- [Fly.io Deployment](docs/fly-io.md)
- [Testing](docs/testing.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Project Structure](#project-structure)

## Architecture

```
                        Consumer (Zenoh -> TAK)
  +-----------+      +-------------------+      +------------+
  |   Zenoh   | ---> |  Transform Plugin | ---> | TAK Server |
  |  (topics) |      |  (per subscription)|     |  (CoT/SSL) |
  +-----------+      +-------------------+      +------------+

                        Producer (TAK -> Zenoh)
  +------------+      +-------------------+      +-----------+
  | TAK Server | ---> |  Raw CoT XML      | ---> |   Zenoh   |
  |  (events)  |      |                   |      |  (topic)  |
  +------------+      +-------------------+      +-----------+
```

**Consumer pipeline**: The adapter subscribes to one or more Zenoh topics. Each subscription specifies a transform plugin that converts the Zenoh payload into a CoT event, which is then sent to the TAK server over a TLS connection.

**Producer pipeline** (optional): When enabled, the adapter listens for CoT events from the TAK server and publishes them as raw CoT XML to a configurable Zenoh topic.

## Quick Start

```bash
# 1. Install dependencies
pnpm install

# 2. Configure environment
cp .env.example .env
# Edit .env -- at minimum set ZENOH_ROUTER_URL, TAK_HOST, TAK_PORT

# 3. Build and run
pnpm run dev
```

> You need a running Zenoh router with the `remote-api` plugin and a reachable TAK server. See [Local Development](docs/local-development.md) for detailed setup instructions.

## Configuration Reference

All configuration is via environment variables. See [`.env.example`](.env.example) for the full annotated reference.

### Key Variables

| Variable              | Required | Default                         | Description                                    |
| --------------------- | -------- | ------------------------------- | ---------------------------------------------- |
| `ZENOH_ROUTER_URL`    | yes      | `ws://localhost:10000` (Docker) | WebSocket URL of the Zenoh remote-api plugin   |
| `ZENOH_TOPIC_PREFIX`  | no       |                                 | Prefix prepended to all subscription topics    |
| `TAK_HOST`            | yes      |                                 | TAK server hostname or IP                      |
| `TAK_PORT`            | yes      |                                 | TAK server port                                |
| `TAK_TLS_CERT`        | no       |                                 | Path or inline PEM for client certificate      |
| `TAK_TLS_KEY`         | no       |                                 | Path or inline PEM for client private key      |
| `TAK_TLS_CA`          | no       |                                 | Path or inline PEM for CA certificate          |
| `ZENOH_SUBSCRIPTIONS` | no       | `[]`                            | JSON array of subscription objects (see below) |
| `PRODUCER_ENABLED`    | no       | `false`                         | Enable TAK-to-Zenoh producer                   |
| `PRODUCER_TOPIC`      | no       | `tak/cot`                       | Zenoh topic for produced CoT XML               |
| `TRANSFORMS_DIR`      | no       |                                 | Directory of custom transform plugins          |
| `LOG_LEVEL`           | no       | `info`                          | `error`, `warn`, `info`, or `debug`            |

### Subscription Format

```json
[
  {
    "topic": "sensors/**",
    "transform": "raw-json",
    "overrides": { "staleMinutes": "5" }
  },
  {
    "topic": "units/position",
    "transform": "simple-cot"
  }
]
```

Each object has:

- `topic` -- Zenoh key expression (supports `**` wildcards)
- `transform` -- Name of a built-in or custom transform plugin (default: `identity`)
- `overrides` -- Optional key/value pairs passed to the transform context

## Built-in Transforms

| Name         | Input                                                        | Output                              |
| ------------ | ------------------------------------------------------------ | ----------------------------------- |
| `identity`   | Valid CoT XML string                                         | Parsed CoT object (pass-through)    |
| `raw-json`   | Arbitrary JSON                                               | CoT marker with JSON in `<remarks>` |
| `simple-cot` | JSON with `lat`, `lon`, `uid`, `callsign`, `type`, `remarks` | Full CoT event                      |

Custom transforms can be loaded from a directory specified by `TRANSFORMS_DIR`. Each file should default-export an object implementing `TransformPlugin` (see `src/transforms/types.ts`).

## Project Structure

```
zeno-tak-adapter-v2/
├── src/
│   ├── index.ts                 # Entry point -- boots consumer & producer
│   ├── config.ts                # Env var parsing with Zod schemas
│   ├── tak-client.ts            # TAK server connection (TLS, heartbeat, CoT)
│   ├── zenoh-client.ts          # Zenoh session, subscriptions, publishing
│   └── transforms/
│       ├── types.ts             # TransformPlugin interface & context
│       ├── registry.ts          # Plugin loader (built-in + custom dir)
│       └── builtin/
│           ├── identity.ts      # Pass-through CoT
│           ├── raw-json.ts      # JSON -> CoT remarks
│           └── simple-cot.ts    # Flat JSON -> CoT fields
├── tests/
│   ├── unit/                    # Config, registry, transform unit tests
│   ├── integration/             # Zenoh consumer/producer pipeline tests
│   └── helpers/                 # Mock TAK server, Zenoh test container
├── scripts/
│   ├── docker-entrypoint.sh     # Container entrypoint (zenohd + app)
│   └── fly-secrets-from-env.sh  # Sync .env to Fly.io secrets
├── docs/
│   ├── local-development.md     # Local dev setup guide
│   ├── docker.md                # Docker build & run
│   ├── fly-io.md                # Fly.io deployment
│   ├── testing.md               # Test strategy & commands
│   └── troubleshooting.md       # Common issues & debug tips
├── Dockerfile                   # Multi-stage build (bun + zenohd)
├── fly.toml                     # Fly.io app configuration
├── build.mjs                    # esbuild bundler script
├── build-tests.mjs              # esbuild bundler for integration tests
├── zenoh-bridge-config.json5    # Zenohd peer/bridge config template
├── zenoh-test-config.json5      # Zenohd standalone config (tests/Docker)
├── .env.example                 # Full env var reference
└── package.json                 # Scripts, dependencies
```
