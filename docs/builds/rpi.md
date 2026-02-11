# Raspberry Pi Image Builds

Build custom Raspberry Pi OS images with Catalyst Node pre-installed. Two
deployment modes are supported: **native binary** (single-process, lower
overhead) and **Docker Compose** (multi-container, service isolation).

The build system has two parts:

| Component | Location | Purpose |
|-----------|----------|---------|
| **Config CLI** | `apps/rpi-config/` | TypeScript CLI that generates rpi-image-gen config YAML |
| **Build runner** | `builds/rpi/` | Shell script + layer definitions that produce a flashable `.img` |

---

## Security Warning

> **The generated config YAML contains passwords and secrets in plain text.**
>
> This includes WiFi passwords, peering secrets, bootstrap tokens, Cloudflare
> Tunnel tokens, and SSH keys. These values are embedded into the image at
> build time.
>
> - **Do not commit generated config files to version control.**
> - **Do not share config files** — they grant full access to the node.
> - **Add `*.yaml` to `.gitignore`** in your config output directory, or use
>   `--dry-run` to pipe YAML without writing to disk.
> - **Rotate secrets** if a config file is accidentally exposed.
>
> The static base configs (`config/base-native.yaml`, `config/base-docker.yaml`)
> use placeholder values and are safe to commit. Only generated configs with
> real credentials require protection.

---

## Quick Start

```bash
# 1. Generate a config (interactive — walks through all options)
bun run apps/rpi-config/src/index.ts -o builds/rpi/my-config.yaml

# 2. Build the image (on a Debian arm64 host)
./builds/rpi/build.sh builds/rpi/my-config.yaml

# 3. Flash to SD card
sudo rpi-imager --cli ./builds/rpi/rpi-image-gen/work/image-catalyst-node-image/catalyst-node-image.img /dev/mmcblk0
```

---

## Directory Structure

```
catalyst-router/
├── apps/
│   └── rpi-config/              # Config generator CLI
│       ├── src/
│       │   ├── index.ts         # Entry point — Commander setup
│       │   ├── prompts.ts       # Interactive prompt sequences
│       │   ├── config-builder.ts # Config object assembly
│       │   ├── yaml-writer.ts   # YAML serialization with inline comments
│       │   ├── validator.ts     # Layer existence validation
│       │   ├── instructions.ts  # Post-write build/flash instructions
│       │   ├── defaults.ts      # Default values and device catalog
│       │   └── types.ts         # Shared TypeScript types
│       ├── package.json
│       └── tsconfig.json
├── builds/
│   └── rpi/                     # rpi-image-gen source directory
│       ├── build.sh             # Build runner script
│       ├── config/
│       │   ├── base-native.yaml # Static base config (native mode)
│       │   └── base-docker.yaml # Static base config (Docker mode)
│       ├── layer/
│       │   ├── catalyst-wifi.yaml
│       │   ├── catalyst-otel.yaml
│       │   ├── catalyst-node.yaml
│       │   ├── catalyst-docker-stack.yaml
│       │   └── catalyst-cloudflared.yaml
│       └── bin/
│           └── .gitkeep         # Pre-built ARM64 binary (native mode)
└── docs/
    └── builds/
        └── rpi.md               # This file
```

---

## Config CLI (`apps/rpi-config/`)

A TypeScript CLI that generates [rpi-image-gen](https://github.com/raspberrypi/rpi-image-gen)
config YAML files. It replaces the need to hand-write config YAML by walking
users through an interactive questionnaire or accepting all values as flags.

### What It Does

1. **Accepts options as CLI flags** — fully scriptable for CI
2. **Prompts interactively** for any missing values when run without `--non-interactive`
3. **Writes a valid rpi-image-gen config YAML** with inline comments explaining each section
4. **Validates that referenced layers exist** in both the source directory and rpi-image-gen tree
5. **Prints build and flash instructions** after writing the config

### Usage

```bash
# Interactive mode — prompts for everything
bun run apps/rpi-config/src/index.ts

# Write to a specific file
bun run apps/rpi-config/src/index.ts -o builds/rpi/my-node.yaml

# Dry run — print YAML to stdout, instructions to stderr
bun run apps/rpi-config/src/index.ts --dry-run

# Fully non-interactive (CI/scripting)
bun run apps/rpi-config/src/index.ts \
  --non-interactive \
  --mode native \
  --output builds/rpi/production.yaml \
  --password "secure-pass" \
  --wifi-ssid "FactoryNet" \
  --wifi-password "factory-pass" \
  --ssh-pubkey-file ~/.ssh/deploy_key.pub \
  --node-id "factory-node-001" \
  --peering-secret "prod-secret"

# Partial flags — prompts only for what's missing
bun run apps/rpi-config/src/index.ts \
  --mode native \
  --wifi-ssid "MyNetwork" \
  --node-id "edge-001"
```

### CLI Options

| Category | Flag | Description | Default |
|----------|------|-------------|---------|
| **Output** | `-o, --output <path>` | Output YAML file path | `./catalyst-node.yaml` |
| | `-m, --mode <mode>` | `native` or `docker` | `native` |
| | `--dry-run` | Print YAML to stdout | — |
| **Device** | `--device <layer>` | Device layer name | `rpi5` |
| | `--hostname <name>` | System hostname | `catalyst-node` |
| | `--username <user>` | Login username | `catalyst` |
| | `--password <pass>` | Login password | — |
| **WiFi** | `--wifi-ssid <ssid>` | WiFi SSID (omit to skip) | — |
| | `--wifi-password <pass>` | WiFi password | — |
| | `--wifi-country <code>` | Regulatory country code | `US` |
| | `--no-wifi` | Explicitly skip WiFi | — |
| **SSH** | `--ssh-pubkey <key>` | SSH public key string | — |
| | `--ssh-pubkey-file <path>` | Read public key from file | — |
| | `--no-ssh-pubkey` | Skip SSH key config | — |
| **Node** | `--node-id <id>` | Node identifier | auto-generated |
| | `--peering-secret <secret>` | iBGP peering secret | — |
| | `--domains <list>` | Comma-separated trusted domains | — |
| | `--port <port>` | Listen port | `3000` |
| | `--bootstrap-token <token>` | Auth bootstrap token | — |
| | `--log-level <level>` | `debug`, `info`, `warn`, `error` | `info` |
| **Docker** | `--registry <url>` | Container registry (docker mode only) | — |
| | `--tag <tag>` | Container image tag | `latest` |
| **OTEL** | `--otel-version <ver>` | OTEL Collector version | `0.145.0` |
| **Tunnel** | `--cloudflared-token <token>` | Cloudflare Tunnel token (omit to skip) | — |
| | `--no-cloudflared` | Explicitly skip cloudflared | — |
| **Image** | `--image-name <name>` | Output image name | `catalyst-node-image` |
| | `--boot-part-size <size>` | Boot partition size | `200%` |
| | `--root-part-size <size>` | Root partition size | `400%` / `500%` |
| **Validation** | `--rpi-image-gen <path>` | Path to rpi-image-gen for layer validation | auto-detected |
| | `--skip-validation` | Skip layer existence checks | — |
| **General** | `--non-interactive` | Skip prompts, use defaults | — |

### Dry Run

`--dry-run` prints the generated YAML to **stdout** and instructions to
**stderr**, keeping them cleanly separated:

```bash
# Preview
bun run apps/rpi-config/src/index.ts --dry-run --non-interactive \
  --password pass --peering-secret s

# Redirect YAML to a file
bun run apps/rpi-config/src/index.ts --dry-run --non-interactive \
  --password pass --peering-secret s > config.yaml 2>/dev/null

# Pipe into rpi-image-gen directly (advanced)
bun run apps/rpi-config/src/index.ts --dry-run --non-interactive \
  --password pass --peering-secret s | \
  rpi-image-gen build -S builds/rpi -c /dev/stdin
```

### Generated YAML

The CLI produces commented YAML so users can understand and hand-edit after
generation:

```yaml
# Generated by catalyst-rpi-config v1.0.0
# Mode: native | Device: rpi5 | WiFi: yes | Cloudflared: yes
# Re-run `catalyst-rpi-config` to regenerate, or edit this file directly.

# Base OS: Debian 12 (Bookworm) minimal with systemd, apt, SSH
include:
  file: bookworm-minbase.yaml

# Target device and login credentials
device:
  layer: rpi5            # Hardware: Raspberry Pi 5
  hostname: catalyst-node
  user1: catalyst        # Login username
  user1pass: changeme    # Login password (change after first boot)

# Layers to include in the build.
# Each entry pulls in a layer YAML and its transitive dependencies.
# Remove a line to exclude that feature from the image.
layer:
  otel: catalyst-otel              # OpenTelemetry Collector (native binary)
  app: catalyst-node               # Catalyst Node composite server
  wifi: catalyst-wifi              # WiFi (wpa_supplicant + systemd-networkd)
  tunnel: catalyst-cloudflared     # Cloudflare Tunnel for remote SSH
```

> **This file will contain real passwords and secrets.** See [Security Warning](#security-warning).

### Module Breakdown

| Module | Responsibility |
|--------|---------------|
| `index.ts` | Commander setup, option parsing, orchestrates the pipeline |
| `prompts.ts` | Interactive prompt sequences via `@inquirer/prompts` — grouped by section, skips flags already provided |
| `config-builder.ts` | Pure function: resolved options in, config object out. Only includes sections for selected features |
| `yaml-writer.ts` | Serializes config to YAML using the `yaml` library Document API. Attaches section and inline comments |
| `validator.ts` | Walks rpi-image-gen's search paths (`layer/`, `device/`, `image/`) to verify every referenced layer exists |
| `instructions.ts` | Prints build prerequisites, `rpi-image-gen build` command, and flash instructions |
| `defaults.ts` | Default values, supported device list, version constants |
| `types.ts` | `ResolvedOptions` and `RpiImageGenConfig` interfaces |

### Dependencies

| Package | Purpose |
|---------|---------|
| `commander` | CLI option parsing (already used by `apps/node`) |
| `@inquirer/prompts` | Interactive select, input, confirm, password prompts |
| `yaml` | YAML serialization with comment node support |

---

## Build Runner (`builds/rpi/`)

The build runner is the rpi-image-gen "source directory" — it contains the
custom layer definitions and a `build.sh` that handles the full pipeline from
cloning rpi-image-gen through producing a flashable image.

### What It Does

`build.sh` accepts a config YAML (generated by the CLI or written by hand)
and runs these steps:

1. **Host check** — warns if not running on Debian arm64
2. **Clone rpi-image-gen** — shallow clone if not already present, or pull latest
3. **Install dependencies** — runs `install_deps.sh` (one-time, requires sudo)
4. **Validate config** — checks required YAML sections exist
5. **Build image** — invokes `rpi-image-gen build -S builds/rpi/ -c <config>`
6. **Print results** — image path and flash instructions

### Usage

```bash
# Standard build
./builds/rpi/build.sh builds/rpi/my-config.yaml

# Use an existing rpi-image-gen checkout
./builds/rpi/build.sh --rpi-image-gen ~/rpi-image-gen my-config.yaml

# Skip deps (already installed)
./builds/rpi/build.sh --skip-deps my-config.yaml

# Custom build output directory
./builds/rpi/build.sh --build-dir /tmp/rpi-build my-config.yaml
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--rpi-image-gen <path>` | Path to existing rpi-image-gen checkout | Clones to `builds/rpi/rpi-image-gen/` |
| `--build-dir <path>` | Build output directory | rpi-image-gen default (`work/`) |
| `--skip-deps` | Skip dependency installation | — |
| `--branch <branch>` | Git branch to clone | `main` |

### Host Requirements

| Requirement | Detail |
|-------------|--------|
| **OS** | Debian Bookworm or Trixie |
| **Architecture** | arm64 (aarch64) |
| **Recommended hardware** | Raspberry Pi 5 running Pi OS |
| **Sudo access** | Required once for `install_deps.sh` |
| **Disk space** | ~4 GB free for a minimal image build |

> rpi-image-gen does not support cross-compilation. The build **must** run
> on an arm64 Debian host. A Raspberry Pi 5 with Pi OS is the recommended
> and supported build environment.

### Static Base Configs

Two base configs are included for direct use without the CLI. They include
only the always-on layers and use placeholder credentials:

| Config | Mode | Layers |
|--------|------|--------|
| `config/base-native.yaml` | Native binary | `catalyst-otel`, `catalyst-node` |
| `config/base-docker.yaml` | Docker Compose | `docker-debian-bookworm`, `catalyst-docker-stack` |

These are safe to commit — they contain no real secrets. To use them directly:

```bash
./builds/rpi/build.sh builds/rpi/config/base-native.yaml
```

WiFi and cloudflared are not included in the base configs. Use the CLI to
generate a config with those features enabled.

---

## Layer Definitions (`builds/rpi/layer/`)

Each layer is a YAML file following the rpi-image-gen layer format. Layers
declare their dependencies, required variables, and install hooks.

### Layer Catalog

| Layer | Category | Description |
|-------|----------|-------------|
| `catalyst-wifi` | net | WiFi via wpa\_supplicant + systemd-networkd for headless boot |
| `catalyst-otel` | app | OpenTelemetry Collector (contrib) native ARM64 binary. Downloads at build time from GitHub releases |
| `catalyst-node` | app | Catalyst Node composite server (auth + gateway + orchestrator) as a pre-compiled Bun binary |
| `catalyst-docker-stack` | app | Catalyst Node multi-container stack via Docker Compose (auth, gateway, orchestrator, OTEL) |
| `catalyst-cloudflared` | net | Cloudflare Tunnel for remote SSH. Installed from the Cloudflare apt repository |

### Layer Dependencies

```
catalyst-wifi
  └── systemd-net-min (built-in)

catalyst-otel
  └── ca-certificates (built-in)

catalyst-node
  ├── catalyst-otel
  ├── rpi-user-credentials (built-in)
  └── ca-certificates (built-in)

catalyst-docker-stack
  ├── rpi-user-credentials (built-in)
  ├── ca-certificates (built-in)
  └── docker provider (docker-debian-bookworm, built-in)

catalyst-cloudflared
  ├── ca-certificates (built-in)
  └── openssh-server (built-in)
```

### Layer Variables

Layers consume variables from the config YAML. rpi-image-gen prefixes them
with `IGconf_<varprefix>_<name>` internally.

**catalyst-wifi** (prefix: `wifi`)

| Variable | Required | Description |
|----------|----------|-------------|
| `ssid` | yes | WiFi network SSID |
| `password` | yes | WiFi password (WPA2-PSK) |
| `country` | no | Regulatory country code (default: `US`) |

**catalyst-otel** (prefix: `otel`)

| Variable | Required | Description |
|----------|----------|-------------|
| `version` | no | OTEL Collector version (default: `0.145.0`) |

**catalyst-node** (prefix: `catalyst`)

| Variable | Required | Description |
|----------|----------|-------------|
| `node_id` | no | Unique node identifier (auto-generated on first boot if empty) |
| `peering_secret` | no | iBGP peering shared secret |
| `domains` | no | Comma-separated trusted domains |
| `port` | no | Listen port (default: `3000`) |
| `bootstrap_token` | no | Initial auth bootstrap token |
| `log_level` | no | `debug`, `info`, `warn`, `error` (default: `info`) |

**catalyst-docker-stack** (prefix: `catalyst`)

Same as `catalyst-node`, plus:

| Variable | Required | Description |
|----------|----------|-------------|
| `registry` | yes | Container registry for catalyst images |
| `tag` | no | Container image tag (default: `latest`) |

**catalyst-cloudflared** (prefix: `cloudflared`)

| Variable | Required | Description |
|----------|----------|-------------|
| `tunnel_token` | yes | Cloudflare Tunnel token from the Zero Trust dashboard |

> **All variable values that contain passwords, secrets, or tokens are written
> in plain text** into the generated config YAML and baked into the image
> filesystem. See [Security Warning](#security-warning).

---

## Deployment Modes

### Native Binary

The composite Catalyst Node server (auth + gateway + orchestrator) runs as a
single Bun-compiled ARM64 binary alongside a native OTEL Collector binary.

**Prerequisites:**
- Build the binary: `bun build --compile --target=bun-linux-arm64 --outfile builds/rpi/bin/catalyst-node apps/node/src/index.ts`
- Place it at `builds/rpi/bin/catalyst-node`

**Boot sequence:**

```
network-online.target
  ├── otelcol.service
  ├── sshd
  └── cloudflared-tunnel.service (optional)
        │
otelcol ready
        │
catalyst-node-firstboot.service (once — generates node ID if needed)
        │
catalyst-node.service
```

**Runtime characteristics:**

| Metric | Value |
|--------|-------|
| RAM usage | ~300–500 MB |
| Boot to ready | ~5–10 s |
| Root partition | 400% |
| Logs | `journalctl -u catalyst-node` |
| Update | Replace binary, restart service |

### Docker Compose

Four containers (auth, gateway, orchestrator, OTEL collector) managed by
Docker Compose with health check dependencies.

**Prerequisites:**
- Publish ARM64 container images to a registry

**Boot sequence:**

```
network-online.target
  ├── docker.service
  ├── sshd
  └── cloudflared-tunnel.service (optional)
        │
docker ready
        │
catalyst-stack-firstboot.service (once — generates node ID, creates volumes)
        │
catalyst-stack.service (docker compose up)
  ├── otel-collector   (health: :13133)
  ├── auth             (health: :5000/health, depends: otel)
  ├── gateway          (health: :4000/health, depends: otel)
  └── orchestrator     (health: :3000/health, depends: auth + gateway)
```

**Runtime characteristics:**

| Metric | Value |
|--------|-------|
| RAM usage | ~1–1.5 GB |
| Boot to ready | ~60–90 s (pull + health checks) |
| Root partition | 500% |
| Logs | `docker compose logs` in `/opt/catalyst-node` |
| Update | `docker compose pull && docker compose up -d` |

### Comparison

| Aspect | Native Binary | Docker Compose |
|--------|---------------|----------------|
| RAM | ~300–500 MB | ~1–1.5 GB |
| Boot to ready | ~5–10 s | ~60–90 s |
| Docker required | No | Yes |
| Root partition | 400% | 500% (container images) |
| Update strategy | Replace binary + restart | `docker compose pull` + restart |
| Debugging | `journalctl -u catalyst-node` | `docker compose logs` |
| Isolation | Single process | Container boundaries |

---

## Runtime Ports

### Native Mode

| Service | Port | Protocol |
|---------|------|----------|
| Catalyst Node (composite) | 3000 | HTTP + WebSocket |
| — `/auth/*` | (same) | Auth, JWKS, token RPC |
| — `/gateway/*` | (same) | GraphQL federation |
| — `/orchestrator/*` | (same) | Peering RPC |
| OTEL Collector (gRPC) | 4317 | OTLP |
| OTEL Collector (HTTP) | 4318 | OTLP |
| OTEL Collector (health) | 13133 | HTTP |
| SSH | 22 | SSH |
| Cloudflare Tunnel | outbound | HTTPS |

### Docker Mode

| Service | Port | Protocol |
|---------|------|----------|
| Orchestrator | 3000 | HTTP + WebSocket |
| Gateway | 4000 | HTTP + WebSocket |
| Auth | 5000 | HTTP + WebSocket |
| OTEL Collector (gRPC) | 4317 | OTLP |
| OTEL Collector (HTTP) | 4318 | OTLP |
| OTEL Collector (health) | 13133 | HTTP |
| SSH | 22 | SSH |
| Cloudflare Tunnel | outbound | HTTPS |

---

## End-to-End Examples

### Minimal Native Image (WiFi Only)

```bash
# Generate config
bun run apps/rpi-config/src/index.ts \
  --non-interactive \
  --mode native \
  --password "changeme" \
  --wifi-ssid "HomeNetwork" \
  --wifi-password "wifi-pass" \
  --ssh-pubkey-file ~/.ssh/id_ed25519.pub \
  --peering-secret "my-secret" \
  -o builds/rpi/home-node.yaml

# Build (on Pi 5)
./builds/rpi/build.sh builds/rpi/home-node.yaml

# Clean up the config (contains secrets)
rm builds/rpi/home-node.yaml
```

### Production Docker Image with Cloudflared

```bash
# Generate config
bun run apps/rpi-config/src/index.ts \
  --non-interactive \
  --mode docker \
  --password "prod-pass" \
  --registry "ghcr.io/your-org" \
  --tag "v1.2.0" \
  --wifi-ssid "CorpNet" \
  --wifi-password "corp-pass" \
  --ssh-pubkey-file ~/.ssh/deploy_key.pub \
  --node-id "prod-edge-001" \
  --peering-secret "prod-secret" \
  --cloudflared-token "eyJhIjoiLi4uIn0=" \
  -o /tmp/prod-config.yaml

# Build
./builds/rpi/build.sh --skip-deps /tmp/prod-config.yaml

# Config is in /tmp — will be cleaned on reboot
```

### Dry-Run Preview

```bash
# See what YAML would be generated without writing anything
bun run apps/rpi-config/src/index.ts --dry-run \
  --non-interactive \
  --mode native \
  --password pass \
  --peering-secret s
```
