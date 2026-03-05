# Raspberry Pi Image Builds

Build custom Raspberry Pi OS images with Catalyst Node pre-installed. Two
deployment modes are supported: **native binary** (single-process, lower
overhead) and **Docker Compose** (multi-container, service isolation).

The build system has two parts:

| Component        | Location           | Purpose                                                          |
| ---------------- | ------------------ | ---------------------------------------------------------------- |
| **Config CLI**   | `apps/rpi-config/` | TypeScript CLI that generates rpi-image-gen config YAML          |
| **Build runner** | `builds/rpi/`      | Shell script + layer definitions that produce a flashable `.img` |

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
│       │   ├── catalyst-console.yaml
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

| Category       | Flag                          | Description                                | Default                |
| -------------- | ----------------------------- | ------------------------------------------ | ---------------------- |
| **Output**     | `-o, --output <path>`         | Output YAML file path                      | `./catalyst-node.yaml` |
|                | `-m, --mode <mode>`           | `native` or `docker`                       | `native`               |
|                | `--dry-run`                   | Print YAML to stdout                       | —                      |
| **Device**     | `--device <layer>`            | Device layer name                          | `rpi5`                 |
|                | `--hostname <name>`           | System hostname                            | `catalyst-node`        |
|                | `--username <user>`           | Login username                             | `catalyst`             |
|                | `--password <pass>`           | Login password                             | —                      |
| **WiFi**       | `--wifi-ssid <ssid>`          | WiFi SSID (omit to skip)                   | —                      |
|                | `--wifi-password <pass>`      | WiFi password                              | —                      |
|                | `--wifi-country <code>`       | Regulatory country code                    | `US`                   |
|                | `--no-wifi`                   | Explicitly skip WiFi                       | —                      |
| **SSH**        | `--ssh-pubkey <key>`          | SSH public key string                      | —                      |
|                | `--ssh-pubkey-file <path>`    | Read public key from file                  | —                      |
|                | `--no-ssh-pubkey`             | Skip SSH key config                        | —                      |
| **Node**       | `--node-id <id>`              | Node identifier                            | auto-generated         |
|                | `--peering-secret <secret>`   | iBGP peering secret                        | —                      |
|                | `--domains <list>`            | Comma-separated trusted domains            | —                      |
|                | `--port <port>`               | Listen port                                | `3000`                 |
|                | `--bootstrap-token <token>`   | Auth bootstrap token                       | —                      |
|                | `--log-level <level>`         | `debug`, `info`, `warn`, `error`           | `info`                 |
| **Docker**     | `--registry <url>`            | Container registry (docker mode only)      | —                      |
|                | `--tag <tag>`                 | Container image tag                        | `latest`               |
| **OTEL**       | `--otel-version <ver>`        | OTEL Collector version                     | `0.145.0`              |
| **Tunnel**     | `--cloudflared-token <token>` | Cloudflare Tunnel token (omit to skip)     | —                      |
|                | `--no-cloudflared`            | Explicitly skip cloudflared                | —                      |
| **Image**      | `--image-name <name>`         | Output image name                          | `catalyst-node-image`  |
|                | `--boot-part-size <size>`     | Boot partition size                        | `200%`                 |
|                | `--root-part-size <size>`     | Root partition size                        | `400%` / `500%`        |
| **Validation** | `--rpi-image-gen <path>`      | Path to rpi-image-gen for layer validation | auto-detected          |
|                | `--skip-validation`           | Skip layer existence checks                | —                      |
| **General**    | `--non-interactive`           | Skip prompts, use defaults                 | —                      |

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
  layer: rpi5 # Hardware: Raspberry Pi 5
  hostname: catalyst-node
  user1: catalyst # Login username
  user1pass: changeme # Login password (change after first boot)

# Layers to include in the build.
# Each entry pulls in a layer YAML and its transitive dependencies.
# Remove a line to exclude that feature from the image.
layer:
  otel: catalyst-otel # OpenTelemetry Collector (native binary)
  app: catalyst-node # Catalyst Node composite server
  wifi: catalyst-wifi # WiFi (wpa_supplicant + systemd-networkd)
  tunnel: catalyst-cloudflared # Cloudflare Tunnel for remote SSH
```

> **This file will contain real passwords and secrets.** See [Security Warning](#security-warning).

### Module Breakdown

| Module              | Responsibility                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `index.ts`          | Commander setup, option parsing, orchestrates the pipeline                                                 |
| `prompts.ts`        | Interactive prompt sequences via `@inquirer/prompts` — grouped by section, skips flags already provided    |
| `config-builder.ts` | Pure function: resolved options in, config object out. Only includes sections for selected features        |
| `yaml-writer.ts`    | Serializes config to YAML using the `yaml` library Document API. Attaches section and inline comments      |
| `validator.ts`      | Walks rpi-image-gen's search paths (`layer/`, `device/`, `image/`) to verify every referenced layer exists |
| `instructions.ts`   | Prints build prerequisites, `rpi-image-gen build` command, and flash instructions                          |
| `defaults.ts`       | Default values, supported device list, version constants                                                   |
| `types.ts`          | `ResolvedOptions` and `RpiImageGenConfig` interfaces                                                       |

### Dependencies

| Package             | Purpose                                              |
| ------------------- | ---------------------------------------------------- |
| `commander`         | CLI option parsing (already used by `apps/node`)     |
| `@inquirer/prompts` | Interactive select, input, confirm, password prompts |
| `yaml`              | YAML serialization with comment node support         |

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

| Flag                     | Description                             | Default                               |
| ------------------------ | --------------------------------------- | ------------------------------------- |
| `--rpi-image-gen <path>` | Path to existing rpi-image-gen checkout | Clones to `builds/rpi/rpi-image-gen/` |
| `--build-dir <path>`     | Build output directory                  | rpi-image-gen default (`work/`)       |
| `--skip-deps`            | Skip dependency installation            | —                                     |
| `--branch <branch>`      | Git branch to clone                     | `master`                              |

### Host Requirements

| Requirement              | Detail                               |
| ------------------------ | ------------------------------------ |
| **OS**                   | Debian Bookworm or Trixie            |
| **Architecture**         | arm64 (aarch64)                      |
| **Recommended hardware** | Raspberry Pi 5 running Pi OS         |
| **Sudo access**          | Required once for `install_deps.sh`  |
| **Disk space**           | ~4 GB free for a minimal image build |

> rpi-image-gen does not support cross-compilation. The build **must** run
> on an arm64 Debian host. A Raspberry Pi 5 with Pi OS is the recommended
> and supported build environment.

### Static Base Configs

Two base configs are included for direct use without the CLI. They include
only the always-on layers and use placeholder credentials:

| Config                    | Mode           | Layers                                            |
| ------------------------- | -------------- | ------------------------------------------------- |
| `config/base-native.yaml` | Native binary  | `catalyst-otel`, `catalyst-node`                  |
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

| Layer                   | Category | Description                                                                                                                                                                                         |
| ----------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalyst-wifi`         | net      | WiFi via wpa_supplicant + systemd-networkd for headless boot. Includes `firmware-brcm80211` and `wireless-regdb` for RPi WiFi hardware support                                                      |
| `catalyst-otel`         | app      | OpenTelemetry Collector (contrib) native ARM64 binary. Downloads at build time from GitHub releases with SHA256 checksum verification                                                               |
| `catalyst-node`         | app      | Catalyst Node composite server (auth + gateway + orchestrator) as a pre-compiled Bun binary. Runs as dedicated `catalyst` user with systemd hardening (ProtectSystem, NoNewPrivileges, MemoryMax)   |
| `catalyst-docker-stack` | app      | Catalyst Node multi-container stack via Docker Compose (auth, gateway, orchestrator, OTEL). Tolerates pull failures on boot to work with cached images                                              |
| `catalyst-console`      | sys      | Autologin on tty1 with live systemd journal stream and `conspy` for remote console mirroring over SSH. Automatically logs in the configured user on the physical console for at-a-glance monitoring |
| `catalyst-cloudflared`  | net      | Cloudflare Tunnel for remote SSH. Installed from the Cloudflare apt repository                                                                                                                      |

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

catalyst-console
  ├── systemd-min (built-in)
  └── rpi-user-credentials (built-in)

catalyst-cloudflared
  ├── ca-certificates (built-in)
  └── openssh-server (built-in)
```

### Layer Variables

Layers consume variables from the config YAML. rpi-image-gen prefixes them
with `IGconf_<varprefix>_<name>` internally.

**catalyst-wifi** (prefix: `wifi`)

| Variable   | Required | Description                                            |
| ---------- | -------- | ------------------------------------------------------ |
| `ssid`     | yes      | WiFi network SSID                                      |
| `password` | no       | WiFi password (WPA2-PSK, leave empty for open network) |
| `country`  | no       | Regulatory country code (default: `US`)                |

**catalyst-otel** (prefix: `otel`)

| Variable  | Required | Description                                 |
| --------- | -------- | ------------------------------------------- |
| `version` | no       | OTEL Collector version (default: `0.145.0`) |

**catalyst-node** (prefix: `catalyst`)

| Variable          | Required | Description                                                    |
| ----------------- | -------- | -------------------------------------------------------------- |
| `node_id`         | no       | Unique node identifier (auto-generated on first boot if empty) |
| `peering_secret`  | no       | iBGP peering shared secret                                     |
| `domains`         | no       | Comma-separated trusted domains                                |
| `port`            | no       | Listen port (default: `3000`)                                  |
| `bootstrap_token` | no       | Initial auth bootstrap token                                   |
| `log_level`       | no       | `debug`, `info`, `warn`, `error` (default: `info`)             |

**catalyst-docker-stack** (prefix: `catalyst`)

Same as `catalyst-node`, plus:

| Variable   | Required | Description                             |
| ---------- | -------- | --------------------------------------- |
| `registry` | yes      | Container registry for catalyst images  |
| `tag`      | no       | Container image tag (default: `latest`) |

**catalyst-console** (no variables — uses `IGconf_device_user1` from device config)

Enables autologin on tty1 and streams the systemd journal, so plugging in
an HDMI monitor shows live service logs without any login required. Includes
`conspy` for remote console mirroring over SSH (`sudo conspy 1`) and grants
the configured user passwordless sudo for `conspy` only.

**catalyst-cloudflared** (prefix: `cloudflared`)

| Variable       | Required | Description                                           |
| -------------- | -------- | ----------------------------------------------------- |
| `tunnel_token` | yes      | Cloudflare Tunnel token from the Zero Trust dashboard |

> **All variable values that contain passwords, secrets, or tokens are written
> in plain text** into the generated config YAML and baked into the image
> filesystem. See [Security Warning](#security-warning).

### Service Hardening

All long-running systemd services include the following protections:

| Directive                                         | Service(s)                                 | Purpose                                                              |
| ------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------- |
| `StartLimitBurst=5` / `StartLimitIntervalSec=120` | catalyst-node, otelcol, cloudflared-tunnel | Prevents infinite crash-restart loops (max 5 restarts per 2 minutes) |
| `User=catalyst`                                   | catalyst-node                              | Runs as a dedicated unprivileged user instead of root                |
| `User=otelcol`                                    | otelcol                                    | Runs as a dedicated system user                                      |
| `ProtectSystem=strict`                            | catalyst-node                              | Mounts filesystem read-only except for `ReadWritePaths`              |
| `ProtectHome=yes`                                 | catalyst-node                              | Denies access to `/home`, `/root`, `/run/user`                       |
| `NoNewPrivileges=yes`                             | catalyst-node                              | Prevents privilege escalation via setuid/setgid binaries             |
| `ReadWritePaths=/var/lib/catalyst-node`           | catalyst-node                              | Only writable path for app data (keys.db, tokens.db)                 |
| `MemoryMax=512M` / `MemoryMax=300M`               | catalyst-node / otelcol                    | OOM-kills the service before it starves the system                   |
| `LimitNOFILE=65536`                               | catalyst-node, otelcol                     | Raises file descriptor limit for high connection counts              |

The firstboot oneshot services use `RemainAfterExit=yes` so systemd correctly
tracks their completion and dependent services start in the right order.

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
  ├── otelcol.service (User=otelcol)
  ├── sshd
  └── cloudflared-tunnel.service (optional)
        │
otelcol ready
        │
catalyst-node-firstboot.service (once — generates node ID, chowns data dir)
        │
catalyst-node.service (User=catalyst, ProtectSystem=strict)
```

**Runtime characteristics:**

| Metric         | Value                           |
| -------------- | ------------------------------- |
| RAM usage      | ~300–500 MB                     |
| Boot to ready  | ~5–10 s                         |
| Root partition | 400%                            |
| Logs           | `journalctl -u catalyst-node`   |
| Update         | Replace binary, restart service |

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

| Metric         | Value                                         |
| -------------- | --------------------------------------------- |
| RAM usage      | ~1–1.5 GB                                     |
| Boot to ready  | ~60–90 s (pull + health checks)               |
| Root partition | 500%                                          |
| Logs           | `docker compose logs` in `/opt/catalyst-node` |
| Update         | `docker compose pull && docker compose up -d` |

### Comparison

| Aspect          | Native Binary                 | Docker Compose                  |
| --------------- | ----------------------------- | ------------------------------- |
| RAM             | ~300–500 MB                   | ~1–1.5 GB                       |
| Boot to ready   | ~5–10 s                       | ~60–90 s                        |
| Docker required | No                            | Yes                             |
| Root partition  | 400%                          | 500% (container images)         |
| Update strategy | Replace binary + restart      | `docker compose pull` + restart |
| Debugging       | `journalctl -u catalyst-node` | `docker compose logs`           |
| Isolation       | Single process                | Container boundaries            |

---

## Runtime Ports

### Native Mode

| Service                   | Port     | Protocol              |
| ------------------------- | -------- | --------------------- |
| Catalyst Node (composite) | 3000     | HTTP + WebSocket      |
| — `/auth/*`               | (same)   | Auth, JWKS, token RPC |
| — `/gateway/*`            | (same)   | GraphQL federation    |
| — `/orchestrator/*`       | (same)   | Peering RPC           |
| OTEL Collector (gRPC)     | 4317     | OTLP                  |
| OTEL Collector (HTTP)     | 4318     | OTLP                  |
| OTEL Collector (health)   | 13133    | HTTP                  |
| SSH                       | 22       | SSH                   |
| Cloudflare Tunnel         | outbound | HTTPS                 |

### Docker Mode

| Service                 | Port     | Protocol         |
| ----------------------- | -------- | ---------------- |
| Orchestrator            | 3000     | HTTP + WebSocket |
| Gateway                 | 4000     | HTTP + WebSocket |
| Auth                    | 5000     | HTTP + WebSocket |
| OTEL Collector (gRPC)   | 4317     | OTLP             |
| OTEL Collector (HTTP)   | 4318     | OTLP             |
| OTEL Collector (health) | 13133    | HTTP             |
| SSH                     | 22       | SSH              |
| Cloudflare Tunnel       | outbound | HTTPS            |

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

---

## Quickstart Script

`builds/rpi/quickstart.sh` automates the entire headless setup flow in a
single command. It detects your current WiFi, generates an SSH key, optionally
sets up a Cloudflare Tunnel, generates the config, compiles the binary, and
builds the image — stopping right before flashing.

### Prerequisites

- macOS or Linux
- Docker Desktop running (the image build happens inside a container)
- `bun` installed
- Connected to the WiFi network you want the Pi to use
- _(Optional)_ A Cloudflare account with a domain for tunnel access

### Usage

```bash
# Minimal — detect WiFi, skip tunnel
./builds/rpi/quickstart.sh --no-tunnel

# With Cloudflare Tunnel for remote SSH
./builds/rpi/quickstart.sh --domain example.com

# Custom hostname and password
./builds/rpi/quickstart.sh --hostname edge-01 --password 'MyPass1!' --domain example.com

# Dry run — generate config only, skip compile and build
./builds/rpi/quickstart.sh --dry-run --no-tunnel
```

### Options

| Flag                      | Description                            | Default          |
| ------------------------- | -------------------------------------- | ---------------- |
| `--password <pass>`       | Login password                         | `Catalyst1!`     |
| `--hostname <name>`       | Pi hostname (mDNS: `<name>.local`)     | `catalyst-node`  |
| `--mode <native\|docker>` | Deployment mode                        | `native`         |
| `--wifi-country <code>`   | WiFi regulatory country code           | `US`             |
| `--domain <domain>`       | Cloudflare domain for tunnel DNS route | —                |
| `--tunnel-name <name>`    | Cloudflare Tunnel name                 | same as hostname |
| `--no-tunnel`             | Skip Cloudflare Tunnel setup           | —                |
| `--dry-run`               | Generate config only, skip build       | —                |

### What It Does

1. **Preflight** — checks Docker is running and `bun` is installed
2. **Detect WiFi** — reads SSID and password from your current connection
   (macOS Keychain or `nmcli` on Linux)
3. **SSH key** — generates `~/.ssh/catalyst-deploy` if it doesn't exist,
   reuses it if it does
4. **Cloudflare Tunnel** _(unless `--no-tunnel`)_ — authenticates (opens
   browser on first run), creates the tunnel, adds a DNS route, and
   retrieves the token
5. **Generate config** — runs the rpi-config CLI with all collected values
6. **Compile binary** — cross-compiles `catalyst-node` for ARM64 (native
   mode only)
7. **Build image** — runs `build-docker.sh` to produce the `.img` file

The script is idempotent — safe to re-run. SSH keys are preserved, existing
Cloudflare Tunnels are reused, and config/binary/image are regenerated with
the latest values.

### Editable Defaults

The top of the script has a defaults block you can edit directly instead of
passing flags every time:

```bash
PASSWORD="Catalyst1!"
PI_HOSTNAME="catalyst-node"
MODE="native"
IMAGE_NAME="catalyst-node-image"
WIFI_COUNTRY="US"
SSH_KEY="$HOME/.ssh/catalyst-deploy"
```

### Security

Secrets (login password, WiFi password, tunnel token) are passed to the
rpi-config CLI via environment variables, not CLI arguments, so they don't
appear in `ps aux`. The env vars are unset after the CLI finishes.

---

## Headless Setup Guide

Complete walkthrough for deploying a Catalyst Node on a Raspberry Pi without
a monitor or keyboard attached. For a faster path, see the
[Quickstart Script](#quickstart-script) above.

### Prerequisites

- Raspberry Pi 5 (or 4, CM5, CM4, Zero 2 W)
- microSD card (16 GB+ recommended)
- WiFi network or Ethernet connection
- A build host: macOS with Docker Desktop, or a Debian arm64 machine

### Step 1: Gather Your Values

Before generating a config, collect the following:

| Value                                    | Where to get it                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Login password**                       | Choose any password you want for SSH/console login to the Pi. This is _your_ password — make it up, there is no default. Must meet the validation rules shown by the CLI.                                                                                                                                                                                                                                                        |
| **WiFi SSID**                            | The exact name of the WiFi network the Pi will connect to. Find it on your router's admin page, or in your device's WiFi settings list (e.g. "HomeNetwork", "CorpGuest"). Case-sensitive.                                                                                                                                                                                                                                        |
| **WiFi password**                        | The password for that WiFi network — the same one you'd type on a phone or laptop. Leave empty for open networks (no password).                                                                                                                                                                                                                                                                                                  |
| **WiFi country code**                    | Two-letter [ISO 3166-1 alpha-2](https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2) code for your country (e.g. `US`, `GB`, `DE`, `JP`). Needed for regulatory compliance — determines which radio frequencies the Pi is allowed to use.                                                                                                                                                                                           |
| **SSH public key**                       | A dedicated SSH key for accessing your Pi fleet. **Don't reuse your personal key** — generate a separate one so you can rotate or revoke it independently: `ssh-keygen -t ed25519 -f ~/.ssh/catalyst-deploy -C "catalyst-deploy"`. This creates `~/.ssh/catalyst-deploy` (private, keep safe) and `~/.ssh/catalyst-deploy.pub` (public, baked into the image). To SSH in later: `ssh -i ~/.ssh/catalyst-deploy catalyst@<host>`. |
| **Peering secret**                       | A shared secret for iBGP peering between Catalyst nodes. Choose any string — all nodes in the same cluster must use the same value. Can be left empty for single-node deployments.                                                                                                                                                                                                                                               |
| **Hostname**                             | The name the Pi will use on the network (for mDNS: `<hostname>.local`). Choose something descriptive like `catalyst-edge-01`.                                                                                                                                                                                                                                                                                                    |
| **Cloudflare Tunnel token** _(optional)_ | Allows SSH access from anywhere without port forwarding. See [Setting Up a Cloudflare Tunnel](#setting-up-a-cloudflare-tunnel) below for a full walkthrough.                                                                                                                                                                                                                                                                     |

### Step 2: Generate the Config

```bash
bun run apps/rpi-config/src/index.ts \
  --non-interactive \
  --mode native \
  --password "your-login-password" \
  --hostname "catalyst-edge-01" \
  --wifi-ssid "YourNetwork" \
  --wifi-password "your-wifi-password" \
  --wifi-country US \
  --ssh-pubkey-file ~/.ssh/catalyst-deploy.pub \
  --peering-secret "your-peering-secret" \
  --log-level info \
  -o dist/rpi
```

> **Tip:** If you're unsure about any value, omit the `--non-interactive` flag
> and the CLI will walk you through each option with prompts instead.

For remote access without port forwarding, add a Cloudflare Tunnel token
(see [Setting Up a Cloudflare Tunnel](#setting-up-a-cloudflare-tunnel) for
how to get one):

```bash
  --cloudflared-token "<your-tunnel-token>"
```

To disable the console journal stream (saves resources if no HDMI is ever
connected):

```bash
  --no-autologin
```

### Step 3: Build the Binary (Native Mode)

```bash
bun build --compile --target=bun-linux-arm64 \
  --outfile dist/rpi/bin/catalyst-node apps/node/src/index.ts
```

### Step 4: Build the Image

**macOS (Docker):**

```bash
./builds/rpi/build-docker.sh --source-dir dist/rpi dist/rpi/config.yaml
```

**Linux arm64 (native):**

```bash
./builds/rpi/build.sh --source-dir dist/rpi dist/rpi/config.yaml
```

### Step 5: Flash the SD Card

**macOS:**

```bash
# Identify SD card
diskutil list

# Unmount (replace N with your disk number)
diskutil unmountDisk /dev/diskN

# Flash (rdisk for raw speed)
sudo dd if=dist/rpi/build/image-catalyst-node-image/catalyst-node-image.img \
  of=/dev/rdiskN bs=4m status=progress

diskutil eject /dev/diskN
```

Or use [Raspberry Pi Imager](https://www.raspberrypi.com/software/) — select
"Use custom" and choose the `.img` file.

### Step 6: Boot and Connect

1. Insert the SD card into the Pi
2. Connect power (and Ethernet, if not using WiFi)
3. Wait 30-60 seconds for first boot

**Find the Pi on your network:**

```bash
# mDNS (avahi-daemon is included in all images)
ping catalyst-edge-01.local

# Subnet scan (fallback if mDNS isn't working on your network)
nmap -sn 192.168.1.0/24

# ARP table (look for Raspberry Pi MAC prefixes: dc:a6, d8:3a, 2c:cf)
arp -a | grep -i "dc:a6\|d8:3a\|2c:cf"
```

**SSH in** (using your dedicated deploy key):

```bash
ssh -i ~/.ssh/catalyst-deploy catalyst@catalyst-edge-01.local
# or
ssh -i ~/.ssh/catalyst-deploy catalyst@<ip-address>
```

If cloudflared is configured, SSH through the tunnel instead — no need to
find the local IP or be on the same network:

```bash
# Requires cloudflared on your laptop (brew install cloudflared / apt install cloudflared)
ssh -o ProxyCommand="cloudflared access ssh --hostname %h" catalyst@ssh.example.com
```

Replace `ssh.example.com` with the public hostname you configured in the
Cloudflare Tunnel (see [Setting Up a Cloudflare Tunnel](#setting-up-a-cloudflare-tunnel)).

### Step 7: Verify Services

```bash
# Check all catalyst services
systemctl status catalyst-node-firstboot catalyst-node otelcol

# Check WiFi
ip addr show wlan0
systemctl status wpa_supplicant@wlan0

# Check cloudflared (if enabled)
systemctl status cloudflared-tunnel
```

### Open Networks and Captive Portals

Some WiFi networks — typically at hotels, airports, conference venues, or
co-working spaces — have no password. You connect by selecting the network name
(SSID) and are then redirected to a web page to accept terms or enter a room
number. These are called **open networks** with **captive portals**.

#### Building for an open network

Omit the `--wifi-password` flag entirely. The `--wifi-ssid` is the network name
you'd see in your phone or laptop's WiFi list (ask the venue front desk if
unsure):

```bash
bun run apps/rpi-config/src/index.ts \
  --non-interactive \
  --mode native \
  --password "your-login-password" \
  --wifi-ssid "HotelWiFi" \
  --ssh-pubkey-file ~/.ssh/catalyst-deploy.pub \
  --peering-secret "your-secret" \
  -o builds/rpi/hotel-node.yaml
```

- `--password` — the password _you choose_ for logging into the Pi via SSH or
  console. This is unrelated to the WiFi password.
- `--wifi-ssid` — the exact WiFi network name, case-sensitive. Look for it in
  the venue's WiFi instructions or scan on your phone first.
- `--ssh-pubkey-file` — path to your dedicated deploy key (see
  [Step 1: Gather Your Values](#step-1-gather-your-values) for how to generate
  one). Use `ssh -i ~/.ssh/catalyst-deploy catalyst@<host>` to connect.
- `--peering-secret` — a string you choose for node-to-node communication.
  Can be left empty for single-node setups.

The image will generate a `key_mgmt=NONE` wpa_supplicant config instead of
using `wpa_passphrase`, so the Pi will associate with the open network
automatically on boot.

#### Authenticating through a captive portal

Many open networks block internet access until you accept terms through a web
page. Since headless Pi images have no graphical browser, `w3m` (a terminal-based
web browser) is included for this purpose.

**You need a way to SSH into the Pi first.** Two options:

1. **Ethernet** — plug the Pi into a wired connection and SSH in over Ethernet.
2. **Same open network** — if your laptop is on the same open network and local
   traffic is allowed, SSH via the Pi's mDNS hostname or IP address.

Once connected via SSH:

```bash
# Open a captive portal detection URL — this will redirect to the venue's
# login page if the network requires portal authentication
w3m http://detectportal.firefox.com

# Alternative detection URLs (some networks only intercept certain ones)
w3m http://captive.apple.com
w3m http://neverssl.com
```

Inside `w3m`: use arrow keys to navigate, Enter to follow links or press
buttons, and `q` to quit when done.

> **Note:** Captive portal sessions typically expire after a period of inactivity
> or on a fixed timer (often 24 hours). This approach is best for temporary
> deployments — conference demos, hotel setups, etc. For permanent installations,
> prefer a WPA2-PSK network with a proper password.

### Setting Up a Cloudflare Tunnel

A Cloudflare Tunnel lets you SSH into your Pi from anywhere — no port
forwarding, no static IP, no VPN. The Pi makes an outbound connection to
Cloudflare's edge network, and you connect through that. This section walks
through getting the tunnel token that the `catalyst-cloudflared` layer needs.

#### Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- A domain added to Cloudflare (even a cheap `.dev` or `.xyz` works — you
  just need Cloudflare managing its DNS)
- `cloudflared` installed on your laptop (see [step 5](#5-ssh-through-the-tunnel)
  for install commands)

#### 1. Authenticate

```bash
cloudflared tunnel login
```

This opens a browser to authorize `cloudflared` with your Cloudflare account.
After you select the domain, credentials are saved to
`~/.cloudflared/cert.pem`.

#### 2. Create the Tunnel and DNS Route

```bash
# Create the tunnel
cloudflared tunnel create catalyst-edge-01

# Add a DNS record pointing to the tunnel (creates a CNAME automatically)
cloudflared tunnel route dns catalyst-edge-01 ssh-edge-01.example.com
```

Replace `ssh-edge-01.example.com` with a subdomain on your
Cloudflare-managed domain.

#### 3. Get the Token

```bash
cloudflared tunnel token catalyst-edge-01
```

This prints the tunnel token — a long base64 string starting with `eyJ...`.
Copy it.

> **Dashboard alternative:** You can also do all of the above in the
> [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/) →
> **Networks** → **Tunnels** → **Create a tunnel**. The token is shown on
> the "Install connector" page after `--token`.

#### 4. Build with the Token

Pass the token to the config CLI:

```bash
bun run apps/rpi-config/src/index.ts \
  --cloudflared-token "eyJhIjoiYWJjZGVm..."
  # ... other flags
```

#### 5. SSH Through the Tunnel

On your laptop, install `cloudflared`:

```bash
# macOS
brew install cloudflared

# Debian/Ubuntu
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install cloudflared
```

Then connect:

```bash
ssh -o ProxyCommand="cloudflared access ssh --hostname %h" \
  -i ~/.ssh/catalyst-deploy \
  catalyst@ssh-edge-01.example.com
```

To avoid typing the `ProxyCommand` every time, add it to `~/.ssh/config`:

```
Host ssh-edge-01.example.com
  User catalyst
  IdentityFile ~/.ssh/catalyst-deploy
  ProxyCommand cloudflared access ssh --hostname %h
```

Then just `ssh ssh-edge-01.example.com`.

> **Tip:** You can create multiple tunnels (one per node) or add multiple
> public hostnames to a single tunnel. For a fleet, one tunnel per node with
> a naming convention like `ssh-edge-001.example.com` keeps things organized.

---

## Operations

### Viewing Logs

```bash
# Catalyst Node logs
journalctl -u catalyst-node -f

# OTEL Collector logs
journalctl -u otelcol -f

# All catalyst-related logs
journalctl -u 'catalyst-*' -u otelcol -f

# Boot log (last boot)
journalctl -b -0

# Firstboot log (ran once on first boot)
journalctl -u catalyst-node-firstboot
```

If the `catalyst-console` layer is enabled, the journal stream is
automatically displayed on HDMI (tty1). Press Ctrl+C for an interactive
shell.

### Remote Console Viewing

The `catalyst-console` layer includes `conspy`, a tool that mirrors a Linux
virtual terminal in your SSH session. This lets you see the exact tty1
output — boot messages, kernel output, and the live journal stream — as if
you plugged in an HDMI monitor.

```bash
# SSH into the node
ssh -i ~/.ssh/catalyst-deploy catalyst@<host>

# Mirror tty1 (the console with the journal stream)
sudo conspy 1
```

No password prompt — the console layer grants passwordless `sudo` for
`conspy` only (via `/etc/sudoers.d/conspy`).

**What you'll see:** the exact tty1 output. If the console layer is enabled,
that's the live `journalctl -f` stream. You'll also see any early boot
messages or kernel output that appeared before journald started.

**Detach:** press `Escape` three times.

**Interact:** you can type into the remote console as if at the physical
keyboard. For example, press Ctrl+C to stop `journalctl` and get an
interactive shell on tty1.

### Restarting Services

```bash
# Restart the main service
sudo systemctl restart catalyst-node

# Restart OTEL collector
sudo systemctl restart otelcol

# Restart everything
sudo systemctl restart otelcol catalyst-node
```

### Updating the Binary (Native Mode)

```bash
# Copy new binary to the Pi
scp catalyst-node catalyst@<host>:/tmp/

# On the Pi
sudo systemctl stop catalyst-node
sudo install -m 755 /tmp/catalyst-node /usr/local/bin/catalyst-node
sudo systemctl start catalyst-node
```

### Updating Containers (Docker Mode)

```bash
# On the Pi
cd /opt/catalyst-node
sudo docker compose pull
sudo docker compose up -d --remove-orphans
```

### Checking Service Health

```bash
# Native mode — composite server
curl -s http://localhost:3000/health

# Docker mode — individual services
curl -s http://localhost:3000/health   # orchestrator
curl -s http://localhost:4000/health   # gateway
curl -s http://localhost:5000/health   # auth
curl -s http://localhost:13133         # OTEL collector
```

### Editing Configuration

```bash
# Node environment (native mode)
sudo nano /etc/catalyst-node/catalyst-node.env
sudo systemctl restart catalyst-node

# Node environment (docker mode)
sudo nano /opt/catalyst-node/.env
cd /opt/catalyst-node && sudo docker compose up -d
```

---

## Troubleshooting

### WiFi Not Connecting

**Symptoms:** No `wlan0` interface, `wpa_supplicant@wlan0` failed, no network
after boot.

```bash
# 1. Check if the WiFi interface exists
ip link show wlan0

# 2. If missing — check firmware loaded
dmesg | grep -i brcm
# Should see: "brcmfmac: brcmf_fw_alloc_request: using brcm/..."

# 3. Check rfkill
rfkill list
# Should show "Soft blocked: no" for wlan0

# 4. Check wpa_supplicant
systemctl status wpa_supplicant@wlan0
journalctl -u wpa_supplicant@wlan0 -b

# 5. Check wpa_supplicant config
cat /etc/wpa_supplicant/wpa_supplicant-wlan0.conf
# Verify SSID and PSK are correct

# 6. Check regulatory domain
iw reg get
# Should show your configured country code

# 7. Manual connection test
sudo wpa_supplicant -i wlan0 -c /etc/wpa_supplicant/wpa_supplicant-wlan0.conf -d
```

**Common causes:**

| Symptom                  | Cause                        | Fix                                                   |
| ------------------------ | ---------------------------- | ----------------------------------------------------- |
| No `wlan0` at all        | Missing `firmware-brcm80211` | Rebuild image (fixed in current version)              |
| `wlan0` exists but no IP | Wrong SSID/password          | Check `/etc/wpa_supplicant/wpa_supplicant-wlan0.conf` |
| `wlan0` soft blocked     | rfkill service not running   | `sudo systemctl start wifi-rfkill-unblock`            |
| Country code error       | Missing `wireless-regdb`     | Rebuild image (fixed in current version)              |

### Service Won't Start

```bash
# Check the service status and recent logs
systemctl status catalyst-node
journalctl -u catalyst-node -b --no-pager -n 50

# Check if firstboot completed
ls -la /var/lib/catalyst-node/.firstboot-done

# Check rate limiting (service restarted too many times)
systemctl show catalyst-node | grep -E 'NRestarts|Result'
# If Result=start-limit-hit:
sudo systemctl reset-failed catalyst-node
sudo systemctl start catalyst-node
```

### Firstboot Didn't Run

```bash
# Check if the marker file exists
ls -la /var/lib/catalyst-node/.firstboot-done   # native
ls -la /opt/catalyst-node/.firstboot-done       # docker

# If missing, check the firstboot log
journalctl -u catalyst-node-firstboot -b        # native
journalctl -u catalyst-stack-firstboot -b        # docker

# Force re-run
sudo rm /var/lib/catalyst-node/.firstboot-done   # native
sudo systemctl start catalyst-node-firstboot

sudo rm /opt/catalyst-node/.firstboot-done       # docker
sudo systemctl start catalyst-stack-firstboot
```

### Docker Compose Stack Not Starting

```bash
# Check the systemd service
systemctl status catalyst-stack
journalctl -u catalyst-stack -b

# Check Docker is running
systemctl status docker

# Check containers directly
cd /opt/catalyst-node
sudo docker compose ps
sudo docker compose logs --tail 50

# If pull failed (no network on first boot), start with cached images
sudo docker compose up -d
```

### No SSH Access

```bash
# From the Pi console (HDMI + keyboard, or serial):

# 1. Check SSH is running
systemctl status ssh

# 2. Check the Pi has an IP
ip addr

# 3. Check SSH config allows your key
cat /etc/ssh/sshd_config.d/*.conf

# 4. Test from the build host
ssh -vvv catalyst@<ip-address>
```

### OTEL Collector Using Too Much Memory

The OTEL collector has a `MemoryMax=300M` limit and an internal
`memory_limiter` processor set to 256 MiB. If it hits the limit:

```bash
# Check memory usage
systemctl status otelcol
journalctl -u otelcol -b | grep -i memory

# Reduce batch size in the config
sudo nano /etc/catalyst-node/otel-config.yaml
# Lower send_batch_size or limit_mib
sudo systemctl restart otelcol
```

### Checking System Resources

```bash
# Overall system health
free -h            # RAM usage
df -h              # Disk usage
uptime             # Load average
vcgencmd measure_temp  # CPU temperature (RPi-specific)

# Per-service resource usage
systemd-cgtop      # Live view of cgroup resource usage
```
