export interface EmbeddedLayer {
  filename: string
  name: string
  content: string
}

const CATALYST_WIFI_YAML = `# METABEGIN
# X-Env-Layer-Name: catalyst-wifi
# X-Env-Layer-Category: net
# X-Env-Layer-Desc: WiFi via wpa_supplicant + systemd-networkd for headless boot
# X-Env-Layer-Version: 1.0.0
# X-Env-Layer-Requires: systemd-net-min
#
# X-Env-VarPrefix: wifi
#
# X-Env-Var-ssid:
# X-Env-Var-ssid-Desc: WiFi network SSID
# X-Env-Var-ssid-Required: y
# X-Env-Var-ssid-Valid: string
# X-Env-Var-ssid-Set: y
#
# X-Env-Var-password:
# X-Env-Var-password-Desc: WiFi network password (WPA2-PSK)
# X-Env-Var-password-Required: y
# X-Env-Var-password-Valid: string
# X-Env-Var-password-Set: y
#
# X-Env-Var-country: US
# X-Env-Var-country-Desc: WiFi regulatory country code (ISO 3166-1 alpha-2)
# X-Env-Var-country-Required: n
# X-Env-Var-country-Valid: regex:^[A-Z]{2}$
# X-Env-Var-country-Set: y
# METAEND
---
mmdebstrap:
  packages:
    - wpasupplicant
    - wireless-tools
    - iw
  customize-hooks:
    # wpa_supplicant config with hashed PSK for the specified network
    - |-
      mkdir -p "$1/etc/wpa_supplicant"
      {
        echo "ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev"
        echo "update_config=1"
        echo "country=$IGconf_wifi_country"
        echo ""
        chroot "$1" wpa_passphrase "$IGconf_wifi_ssid" "$IGconf_wifi_password" \\
          | grep -v '#psk='
      } > "$1/etc/wpa_supplicant/wpa_supplicant-wlan0.conf"
      chmod 600 "$1/etc/wpa_supplicant/wpa_supplicant-wlan0.conf"
    # systemd-networkd config for wlan0 (DHCP)
    - |-
      cat > "$1/etc/systemd/network/20-wlan0.network" <<NETEOF
      [Match]
      Name=wlan0

      [Network]
      DHCP=yes

      [DHCPv4]
      RouteMetric=600
      NETEOF
    # Ensure WiFi radio is not soft-blocked (common on minimal images)
    - chroot "$1" rfkill unblock wifi 2>/dev/null || true
    # Ensure resolv.conf points to systemd-resolved stub (safety net)
    - ln -sf /run/systemd/resolve/stub-resolv.conf "$1/etc/resolv.conf"
    # Ensure network-online.target waits for an interface to get an address
    - $BDEBSTRAP_HOOKS/enable-units "$1" systemd-networkd-wait-online
    # Enable wpa_supplicant for wlan0
    - $BDEBSTRAP_HOOKS/enable-units "$1" wpa_supplicant@wlan0
`

const CATALYST_OTEL_YAML = `# METABEGIN
# X-Env-Layer-Name: catalyst-otel
# X-Env-Layer-Category: app
# X-Env-Layer-Desc: OpenTelemetry Collector (contrib) native binary for ARM64.
#  Downloads the release tarball at build time and installs as a systemd service.
# X-Env-Layer-Version: 1.0.0
# X-Env-Layer-Requires: ca-certificates
#
# X-Env-VarPrefix: otel
#
# X-Env-Var-version: 0.145.0
# X-Env-Var-version-Desc: OTEL Collector version to install
# X-Env-Var-version-Required: n
# X-Env-Var-version-Valid: string
# X-Env-Var-version-Set: y
# METAEND
---
mmdebstrap:
  packages:
    - curl
  customize-hooks:
    # Download and install otelcol-contrib binary
    - |-
      OTEL_VERSION="$IGconf_otel_version"
      OTEL_URL="https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v\${OTEL_VERSION}/otelcol-contrib_\${OTEL_VERSION}_linux_arm64.tar.gz"
      echo "Downloading otelcol-contrib v\${OTEL_VERSION}..."
      curl -fsSL "$OTEL_URL" -o /tmp/otelcol.tar.gz
      tar -xzf /tmp/otelcol.tar.gz -C /tmp otelcol-contrib
      install -m 755 /tmp/otelcol-contrib "$1/usr/local/bin/otelcol-contrib"
      rm -f /tmp/otelcol.tar.gz /tmp/otelcol-contrib
    # Create config directory
    - mkdir -p "$1/etc/catalyst-node"
    # Install OTEL config
    - |-
      cat > "$1/etc/catalyst-node/otel-config.yaml" <<'OTELEOF'
      extensions:
        health_check:
          endpoint: 0.0.0.0:13133

      receivers:
        otlp:
          protocols:
            grpc:
              endpoint: 0.0.0.0:4317
            http:
              endpoint: 0.0.0.0:4318

      processors:
        batch:
          send_batch_size: 512
          timeout: 5s
        memory_limiter:
          check_interval: 5s
          limit_mib: 256

      exporters:
        debug:
          verbosity: detailed

      service:
        extensions: [health_check]
        pipelines:
          traces:
            receivers: [otlp]
            processors: [memory_limiter, batch]
            exporters: [debug]
          metrics:
            receivers: [otlp]
            processors: [memory_limiter, batch]
            exporters: [debug]
          logs:
            receivers: [otlp]
            processors: [memory_limiter, batch]
            exporters: [debug]
      OTELEOF
    # Create dedicated otelcol user
    - chroot "$1" useradd --system --no-create-home --shell /usr/sbin/nologin otelcol
    # Install systemd service
    - |-
      cat > "$1/etc/systemd/system/otelcol.service" <<'SVCEOF'
      [Unit]
      Description=OpenTelemetry Collector
      After=network-online.target
      Wants=network-online.target

      [Service]
      Type=simple
      User=otelcol
      ExecStart=/usr/local/bin/otelcol-contrib --config /etc/catalyst-node/otel-config.yaml
      Restart=on-failure
      RestartSec=5
      MemoryMax=300M
      LimitNOFILE=65536

      [Install]
      WantedBy=multi-user.target
      SVCEOF
    - $BDEBSTRAP_HOOKS/enable-units "$1" otelcol
`

const CATALYST_NODE_YAML = `# METABEGIN
# X-Env-Layer-Name: catalyst-node
# X-Env-Layer-Category: app
# X-Env-Layer-Desc: Catalyst Node composite server (auth + gateway + orchestrator)
#  as a pre-compiled Bun binary. Includes first-boot provisioning and systemd service.
# X-Env-Layer-Version: 1.0.0
# X-Env-Layer-Requires: catalyst-otel,rpi-user-credentials,ca-certificates
#
# X-Env-VarPrefix: catalyst
#
# X-Env-Var-node_id:
# X-Env-Var-node_id-Desc: Unique node identifier (e.g. edge-node-001)
# X-Env-Var-node_id-Required: n
# X-Env-Var-node_id-Valid: string-or-empty
# X-Env-Var-node_id-Set: y
#
# X-Env-Var-peering_secret:
# X-Env-Var-peering_secret-Desc: iBGP peering shared secret
# X-Env-Var-peering_secret-Required: n
# X-Env-Var-peering_secret-Valid: string-or-empty
# X-Env-Var-peering_secret-Set: y
#
# X-Env-Var-domains:
# X-Env-Var-domains-Desc: Comma-separated list of trusted domains
# X-Env-Var-domains-Required: n
# X-Env-Var-domains-Valid: string-or-empty
# X-Env-Var-domains-Set: y
#
# X-Env-Var-port: 3000
# X-Env-Var-port-Desc: Listen port for the composite server
# X-Env-Var-port-Required: n
# X-Env-Var-port-Valid: int:1024-65535
# X-Env-Var-port-Set: y
#
# X-Env-Var-bootstrap_token:
# X-Env-Var-bootstrap_token-Desc: Initial auth bootstrap token
# X-Env-Var-bootstrap_token-Required: n
# X-Env-Var-bootstrap_token-Valid: string-or-empty
# X-Env-Var-bootstrap_token-Set: y
#
# X-Env-Var-log_level: info
# X-Env-Var-log_level-Desc: Log level (debug, info, warn, error)
# X-Env-Var-log_level-Required: n
# X-Env-Var-log_level-Valid: keywords:debug,info,warn,error
# X-Env-Var-log_level-Set: y
# METAEND
---
mmdebstrap:
  customize-hooks:
    # Install the pre-built catalyst-node binary from source directory
    - install -m 755 "$SRCROOT/bin/catalyst-node" "$1/usr/local/bin/catalyst-node"
    # Create data and config directories
    - |-
      mkdir -p "$1/var/lib/catalyst-node"
      mkdir -p "$1/etc/catalyst-node"
    # Install environment file with build-time values
    - |-
      cat > "$1/etc/catalyst-node/catalyst-node.env" <<ENVEOF
      # Catalyst Node Configuration
      # Values set at image build time. Edit after first boot as needed.
      CATALYST_NODE_ID=$IGconf_catalyst_node_id
      CATALYST_PEERING_SECRET=$IGconf_catalyst_peering_secret
      CATALYST_DOMAINS=$IGconf_catalyst_domains
      PORT=$IGconf_catalyst_port
      CATALYST_BOOTSTRAP_TOKEN=$IGconf_catalyst_bootstrap_token
      CATALYST_AUTH_KEYS_DB=/var/lib/catalyst-node/keys.db
      CATALYST_AUTH_TOKENS_DB=/var/lib/catalyst-node/tokens.db
      OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
      OTEL_SERVICE_NAME=catalyst-node
      ENVEOF
      chmod 600 "$1/etc/catalyst-node/catalyst-node.env"
    # Install first-boot provisioning script
    - |-
      cat > "$1/usr/local/bin/catalyst-firstboot" <<'FBEOF'
      #!/bin/bash
      set -euo pipefail

      ENV_FILE="/etc/catalyst-node/catalyst-node.env"

      # Source existing env for variable access
      set -a; source "$ENV_FILE"; set +a

      # Generate unique node ID if not set at build time
      if [ -z "\${CATALYST_NODE_ID:-}" ]; then
        NODE_ID="edge-$(hostname)-$(cat /proc/sys/kernel/random/boot_id | cut -c1-8)"
        sed -i "s/^CATALYST_NODE_ID=.*/CATALYST_NODE_ID=\${NODE_ID}/" "$ENV_FILE"
        echo "Generated node ID: \${NODE_ID}"
      fi

      # Ensure data directory exists with correct permissions
      mkdir -p /var/lib/catalyst-node
      chmod 750 /var/lib/catalyst-node

      echo "First boot setup complete"
      FBEOF
      chmod 755 "$1/usr/local/bin/catalyst-firstboot"
    # Install first-boot systemd service (runs once)
    - |-
      cat > "$1/etc/systemd/system/catalyst-node-firstboot.service" <<'SVCEOF'
      [Unit]
      Description=Catalyst Node First Boot Setup
      After=network-online.target
      Before=catalyst-node.service
      ConditionPathExists=!/var/lib/catalyst-node/.firstboot-done

      [Service]
      Type=oneshot
      ExecStart=/usr/local/bin/catalyst-firstboot
      ExecStartPost=/usr/bin/touch /var/lib/catalyst-node/.firstboot-done
      RemainAfterExit=no

      [Install]
      WantedBy=multi-user.target
      SVCEOF
    - $BDEBSTRAP_HOOKS/enable-units "$1" catalyst-node-firstboot
    # Install main catalyst-node systemd service
    - |-
      cat > "$1/etc/systemd/system/catalyst-node.service" <<'SVCEOF'
      [Unit]
      Description=Catalyst Node
      After=otelcol.service network-online.target catalyst-node-firstboot.service
      Wants=otelcol.service network-online.target
      Requires=catalyst-node-firstboot.service

      [Service]
      Type=simple
      EnvironmentFile=/etc/catalyst-node/catalyst-node.env
      ExecStart=/usr/local/bin/catalyst-node
      WorkingDirectory=/var/lib/catalyst-node
      Restart=on-failure
      RestartSec=5

      [Install]
      WantedBy=multi-user.target
      SVCEOF
    - $BDEBSTRAP_HOOKS/enable-units "$1" catalyst-node
`

const CATALYST_DOCKER_STACK_YAML = `# METABEGIN
# X-Env-Layer-Name: catalyst-docker-stack
# X-Env-Layer-Category: app
# X-Env-Layer-Desc: Catalyst Node multi-container stack via Docker Compose.
#  Installs compose file, OTEL config, env template, first-boot provisioning,
#  and a systemd service that pulls and starts the stack on boot.
# X-Env-Layer-Version: 1.0.0
# X-Env-Layer-Requires: rpi-user-credentials,ca-certificates
# X-Env-Layer-RequiresProvider: docker
#
# X-Env-VarPrefix: catalyst
#
# X-Env-Var-registry: ghcr.io/your-org
# X-Env-Var-registry-Desc: Container registry for catalyst images
# X-Env-Var-registry-Required: y
# X-Env-Var-registry-Valid: string
# X-Env-Var-registry-Set: y
#
# X-Env-Var-tag: latest
# X-Env-Var-tag-Desc: Container image tag to deploy
# X-Env-Var-tag-Required: n
# X-Env-Var-tag-Valid: string
# X-Env-Var-tag-Set: y
#
# X-Env-Var-node_id:
# X-Env-Var-node_id-Desc: Unique node identifier (e.g. edge-node-001)
# X-Env-Var-node_id-Required: n
# X-Env-Var-node_id-Valid: string-or-empty
# X-Env-Var-node_id-Set: y
#
# X-Env-Var-peering_secret:
# X-Env-Var-peering_secret-Desc: iBGP peering shared secret
# X-Env-Var-peering_secret-Required: n
# X-Env-Var-peering_secret-Valid: string-or-empty
# X-Env-Var-peering_secret-Set: y
#
# X-Env-Var-domains:
# X-Env-Var-domains-Desc: Comma-separated list of trusted domains
# X-Env-Var-domains-Required: n
# X-Env-Var-domains-Valid: string-or-empty
# X-Env-Var-domains-Set: y
#
# X-Env-Var-bootstrap_token:
# X-Env-Var-bootstrap_token-Desc: Initial auth bootstrap token
# X-Env-Var-bootstrap_token-Required: n
# X-Env-Var-bootstrap_token-Valid: string-or-empty
# X-Env-Var-bootstrap_token-Set: y
#
# X-Env-Var-log_level: info
# X-Env-Var-log_level-Desc: Log level (debug, info, warn, error)
# X-Env-Var-log_level-Required: n
# X-Env-Var-log_level-Valid: keywords:debug,info,warn,error
# X-Env-Var-log_level-Set: y
# METAEND
---
mmdebstrap:
  customize-hooks:
    # Create application directory
    - mkdir -p "$1/opt/catalyst-node"
    # --- Docker Compose file ---
    - |-
      cat > "$1/opt/catalyst-node/docker-compose.yaml" <<'COMPEOF'
      services:
        otel-collector:
          image: otel/opentelemetry-collector-contrib:0.145.0
          container_name: catalyst-otel-collector
          command: ['--config', '/etc/otel-collector-config.yaml']
          volumes:
            - ./otel-collector-config.yaml:/etc/otel-collector-config.yaml:ro
          ports:
            - '4317:4317'
            - '4318:4318'
          restart: unless-stopped
          healthcheck:
            test: ['CMD', 'wget', '--no-verbose', '--tries=1', '--spider', 'http://localhost:13133']
            interval: 10s
            timeout: 5s
            retries: 5

        auth:
          image: \${CATALYST_REGISTRY}/catalyst-auth:\${CATALYST_TAG:-latest}
          container_name: catalyst-auth
          ports:
            - '5000:5000'
          environment:
            - PORT=5000
            - CATALYST_BOOTSTRAP_TOKEN=\${CATALYST_BOOTSTRAP_TOKEN:-}
            - CATALYST_AUTH_KEYS_DB=/data/keys.db
            - CATALYST_AUTH_TOKENS_DB=/data/tokens.db
            - OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
            - OTEL_SERVICE_NAME=catalyst-auth
          volumes:
            - auth-data:/data
          restart: unless-stopped
          healthcheck:
            test: ['CMD', 'wget', '--no-verbose', '--tries=1', '--spider', 'http://localhost:5000/health']
            interval: 5s
            timeout: 3s
            retries: 10
          depends_on:
            otel-collector:
              condition: service_healthy

        gateway:
          image: \${CATALYST_REGISTRY}/catalyst-gateway:\${CATALYST_TAG:-latest}
          container_name: catalyst-gateway
          ports:
            - '4000:4000'
          environment:
            - PORT=4000
            - OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
            - OTEL_SERVICE_NAME=catalyst-gateway
          restart: unless-stopped
          healthcheck:
            test: ['CMD', 'wget', '--no-verbose', '--tries=1', '--spider', 'http://localhost:4000/health']
            interval: 10s
            timeout: 5s
            retries: 5
          depends_on:
            otel-collector:
              condition: service_healthy

        orchestrator:
          image: \${CATALYST_REGISTRY}/catalyst-orchestrator:\${CATALYST_TAG:-latest}
          container_name: catalyst-orchestrator
          ports:
            - '3000:3000'
          environment:
            - PORT=3000
            - CATALYST_NODE_ID=\${CATALYST_NODE_ID}
            - CATALYST_GQL_GATEWAY_ENDPOINT=ws://gateway:4000/api
            - CATALYST_AUTH_ENDPOINT=ws://auth:5000/rpc
            - CATALYST_SYSTEM_TOKEN=\${CATALYST_SYSTEM_TOKEN:-}
            - CATALYST_PEERING_SECRET=\${CATALYST_PEERING_SECRET:-}
            - CATALYST_DOMAINS=\${CATALYST_DOMAINS:-}
            - OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
            - OTEL_SERVICE_NAME=catalyst-orchestrator
          restart: unless-stopped
          healthcheck:
            test: ['CMD', 'wget', '--no-verbose', '--tries=1', '--spider', 'http://localhost:3000/health']
            interval: 10s
            timeout: 5s
            retries: 5
          depends_on:
            auth:
              condition: service_healthy
            gateway:
              condition: service_healthy

      volumes:
        auth-data:
      COMPEOF
    # --- OTEL Collector config ---
    - |-
      cat > "$1/opt/catalyst-node/otel-collector-config.yaml" <<'OTELEOF'
      extensions:
        health_check:
          endpoint: 0.0.0.0:13133

      receivers:
        otlp:
          protocols:
            grpc:
              endpoint: 0.0.0.0:4317
            http:
              endpoint: 0.0.0.0:4318

      processors:
        batch:
          send_batch_size: 512
          timeout: 5s
        memory_limiter:
          check_interval: 5s
          limit_mib: 256

      exporters:
        debug:
          verbosity: detailed

      service:
        extensions: [health_check]
        pipelines:
          traces:
            receivers: [otlp]
            processors: [memory_limiter, batch]
            exporters: [debug]
          metrics:
            receivers: [otlp]
            processors: [memory_limiter, batch]
            exporters: [debug]
          logs:
            receivers: [otlp]
            processors: [memory_limiter, batch]
            exporters: [debug]
      OTELEOF
    # --- Environment file ---
    - |-
      cat > "$1/opt/catalyst-node/.env" <<ENVEOF
      # Container registry
      CATALYST_REGISTRY=$IGconf_catalyst_registry
      CATALYST_TAG=$IGconf_catalyst_tag

      # Node identity
      CATALYST_NODE_ID=$IGconf_catalyst_node_id
      CATALYST_PEERING_SECRET=$IGconf_catalyst_peering_secret
      CATALYST_DOMAINS=$IGconf_catalyst_domains

      # Auth
      CATALYST_BOOTSTRAP_TOKEN=$IGconf_catalyst_bootstrap_token
      CATALYST_SYSTEM_TOKEN=
      ENVEOF
      chmod 600 "$1/opt/catalyst-node/.env"
    # --- First-boot provisioning script ---
    - |-
      cat > "$1/usr/local/bin/catalyst-firstboot" <<'FBEOF'
      #!/bin/bash
      set -euo pipefail

      ENV_FILE="/opt/catalyst-node/.env"

      # Source existing env
      set -a; source "$ENV_FILE"; set +a

      # Generate unique node ID if not set at build time
      if [ -z "\${CATALYST_NODE_ID:-}" ]; then
        NODE_ID="edge-$(hostname)-$(cat /proc/sys/kernel/random/boot_id | cut -c1-8)"
        sed -i "s/^CATALYST_NODE_ID=.*/CATALYST_NODE_ID=\${NODE_ID}/" "$ENV_FILE"
        echo "Generated node ID: \${NODE_ID}"
      fi

      # Ensure the auth data volume mount point is writable
      docker volume create --label com.catalyst=auth auth-data 2>/dev/null || true

      echo "First boot setup complete"
      FBEOF
      chmod 755 "$1/usr/local/bin/catalyst-firstboot"
    # --- First-boot systemd service (runs once) ---
    - |-
      cat > "$1/etc/systemd/system/catalyst-stack-firstboot.service" <<'SVCEOF'
      [Unit]
      Description=Catalyst Stack First Boot Setup
      After=docker.service network-online.target
      Requires=docker.service
      ConditionPathExists=!/opt/catalyst-node/.firstboot-done

      [Service]
      Type=oneshot
      ExecStart=/usr/local/bin/catalyst-firstboot
      ExecStartPost=/usr/bin/touch /opt/catalyst-node/.firstboot-done
      RemainAfterExit=no

      [Install]
      WantedBy=multi-user.target
      SVCEOF
    - $BDEBSTRAP_HOOKS/enable-units "$1" catalyst-stack-firstboot
    # --- Main Docker Compose systemd service ---
    - |-
      cat > "$1/etc/systemd/system/catalyst-stack.service" <<'SVCEOF'
      [Unit]
      Description=Catalyst Node Stack (Docker Compose)
      After=docker.service network-online.target catalyst-stack-firstboot.service
      Requires=docker.service catalyst-stack-firstboot.service
      Wants=network-online.target

      [Service]
      Type=oneshot
      RemainAfterExit=yes
      WorkingDirectory=/opt/catalyst-node
      ExecStartPre=/usr/bin/docker compose pull --quiet
      ExecStart=/usr/bin/docker compose up -d --remove-orphans
      ExecStop=/usr/bin/docker compose down
      TimeoutStartSec=600

      [Install]
      WantedBy=multi-user.target
      SVCEOF
    - $BDEBSTRAP_HOOKS/enable-units "$1" catalyst-stack
    # Ensure files are owned by root
    - chroot "$1" chown -R root:root /opt/catalyst-node
`

const CATALYST_CONSOLE_YAML = `# METABEGIN
# X-Env-Layer-Name: catalyst-console
# X-Env-Layer-Category: sys
# X-Env-Layer-Desc: Autologin on tty1 and live systemd journal stream.
#  Automatically logs in the configured user on the physical console
#  and follows all journal entries so you can monitor services at a glance.
# X-Env-Layer-Version: 1.0.0
# X-Env-Layer-Requires: systemd-min,rpi-user-credentials
#
# X-Env-VarRequires: IGconf_device_user1
# X-Env-VarRequires-Valid: string
# METAEND
---
mmdebstrap:
  customize-hooks:
    # Enable autologin on tty1 for the configured user
    - |-
      mkdir -p "$1/etc/systemd/system/getty@tty1.service.d"
      cat > "$1/etc/systemd/system/getty@tty1.service.d/autologin.conf" <<ALEOF
      [Service]
      ExecStart=
      ExecStart=-/sbin/agetty --autologin $IGconf_device_user1 --noclear %I \\$TERM
      ALEOF
    # Stream systemd journal on tty1 login
    - |-
      HOME_DIR="$1/home/$IGconf_device_user1"
      mkdir -p "$HOME_DIR"
      cat >> "$HOME_DIR/.bash_profile" <<'BPEOF'

      # --- Catalyst Console: live journal stream on tty1 ---
      if [ "$(tty)" = "/dev/tty1" ]; then
        printf '\\n\\033[1m=== Catalyst Node — Journal Stream ===\\033[0m\\n'
        printf 'Press Ctrl+C for an interactive shell.\\n\\n'
        journalctl -f --no-hostname -o short-precise
      fi
      BPEOF
      chown -R 1000:1000 "$HOME_DIR/.bash_profile"
`

const CATALYST_CLOUDFLARED_YAML = `# METABEGIN
# X-Env-Layer-Name: catalyst-cloudflared
# X-Env-Layer-Category: net
# X-Env-Layer-Desc: Cloudflare Tunnel for remote SSH access.
#  Requires a tunnel token from the Cloudflare Zero Trust dashboard.
# X-Env-Layer-Version: 1.0.0
# X-Env-Layer-Requires: ca-certificates,openssh-server
#
# X-Env-VarRequires: IGconf_sys_apt_keydir
# X-Env-VarRequires-Valid: string
#
# X-Env-VarPrefix: cloudflared
#
# X-Env-Var-tunnel_token:
# X-Env-Var-tunnel_token-Desc: Cloudflare Tunnel token (from dashboard or CLI)
# X-Env-Var-tunnel_token-Required: y
# X-Env-Var-tunnel_token-Valid: string
# X-Env-Var-tunnel_token-Set: y
# METAEND
---
mmdebstrap:
  mirrors:
    - deb https://pkg.cloudflare.com/cloudflared bookworm main
  setup-hooks:
    - mkdir -p $1/usr/share/keyrings/
    - curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o $1/usr/share/keyrings/cloudflare-main.gpg
    - chmod a+r $1/usr/share/keyrings/cloudflare-main.gpg
    - cp -p $1/usr/share/keyrings/cloudflare-main.gpg $IGconf_sys_apt_keydir
  packages:
    - cloudflared
  customize-hooks:
    # Permanent sources.list entry for the installed system
    - mkdir -p $1/etc/apt/sources.list.d
    - |-
      cat <<- EOF > $1/etc/apt/sources.list.d/cloudflared.list
      deb [arch=arm64 signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared bookworm main
      EOF
    - sed -i '/pkg\\.cloudflare\\.com/d' $1/etc/apt/sources.list
    # Allow unprivileged ICMP ping sockets (required by cloudflared health checks)
    - |-
      mkdir -p "$1/etc/sysctl.d"
      cat > "$1/etc/sysctl.d/50-cloudflared-ping.conf" <<SYSEOF
      net.ipv4.ping_group_range = 0 2147483647
      SYSEOF
    # Install systemd service with tunnel token
    - |-
      cat > "$1/etc/systemd/system/cloudflared-tunnel.service" <<SVCEOF
      [Unit]
      Description=Cloudflare Tunnel
      After=network-online.target wpa_supplicant@wlan0.service
      Wants=network-online.target

      [Service]
      Type=simple
      ExecStart=/usr/bin/cloudflared tunnel --no-autoupdate run --token $IGconf_cloudflared_tunnel_token
      Restart=on-failure
      RestartSec=5
      AmbientCapabilities=CAP_NET_RAW
      CapabilityBoundingSet=CAP_NET_RAW

      [Install]
      WantedBy=multi-user.target
      SVCEOF
    - $BDEBSTRAP_HOOKS/enable-units "$1" cloudflared-tunnel
`

export const EMBEDDED_LAYERS: readonly EmbeddedLayer[] = [
  {
    filename: 'catalyst-wifi.yaml',
    name: 'catalyst-wifi',
    content: CATALYST_WIFI_YAML,
  },
  {
    filename: 'catalyst-otel.yaml',
    name: 'catalyst-otel',
    content: CATALYST_OTEL_YAML,
  },
  {
    filename: 'catalyst-node.yaml',
    name: 'catalyst-node',
    content: CATALYST_NODE_YAML,
  },
  {
    filename: 'catalyst-docker-stack.yaml',
    name: 'catalyst-docker-stack',
    content: CATALYST_DOCKER_STACK_YAML,
  },
  {
    filename: 'catalyst-console.yaml',
    name: 'catalyst-console',
    content: CATALYST_CONSOLE_YAML,
  },
  {
    filename: 'catalyst-cloudflared.yaml',
    name: 'catalyst-cloudflared',
    content: CATALYST_CLOUDFLARED_YAML,
  },
] as const

export function findLayer(name: string): EmbeddedLayer | undefined {
  return EMBEDDED_LAYERS.find((layer) => layer.name === name)
}
