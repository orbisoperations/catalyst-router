# ADR-0005: Docker as Container Runtime

**Status:** Accepted
**Date:** 2026-01-27
**Decision Owner(s):** @jtaylor-orbis @jaeyojae @gsantiago-orbis

## Context

The catalyst-node project requires a container runtime for local development, integration testing (testcontainers), and CI/CD pipelines (GitHub Actions). The team initially attempted to avoid Docker Desktop due to its commercial licensing requirements, exploring free alternatives instead.

### Current State

The project relies heavily on containers across multiple surfaces:

| Surface           | Usage                                                             | Files                                      |
| ----------------- | ----------------------------------------------------------------- | ------------------------------------------ |
| Service packaging | Multi-stage Dockerfiles for orchestrator, gateway, auth, examples | `packages/*/Dockerfile`                    |
| Integration tests | testcontainers for topology E2E tests                             | `*.container.test.ts`                      |
| Local development | Docker Compose for multi-service orchestration                    | `docker-compose/example.m0p2.compose.yaml` |
| CI/CD             | GitHub Actions workflows                                          | `.github/workflows/`                       |

The team spent significant time attempting to use Podman and Colima + Docker CLI as free alternatives. These attempts surfaced persistent compatibility issues that blocked development progress:

- **Podman:** Socket compatibility issues with testcontainers (`dockerode` expects the Docker API); rootless networking behaved differently from Docker, causing container-to-container communication failures in topology tests; Docker Compose files required translation to `podman-compose` which had feature gaps.
- **Colima + Docker CLI:** Colima's Lima VM layer introduced intermittent mount and networking issues on macOS; DNS resolution between containers was unreliable; the additional abstraction layer made debugging container failures harder; VM resource allocation required manual tuning per machine.

These issues were not individually insurmountable, but the cumulative debugging time was disproportionate to the value of avoiding Docker Desktop licensing.

### Requirements

| Requirement                               | Priority | Notes                            |
| ----------------------------------------- | -------- | -------------------------------- |
| Reproducible builds across dev machines   | Must     | Eliminates "works on my machine" |
| testcontainers compatibility              | Must     | Topology E2E tests depend on it  |
| GitHub Actions compatibility              | Must     | CI must match local behavior     |
| Docker Compose support                    | Must     | Multi-service local dev          |
| macOS and Linux support                   | Must     | Team uses both                   |
| License compliance                        | Must     | Commercial use permitted         |
| Minimal setup friction for new developers | Should   | Onboarding cost matters          |

## Decision

**Chosen Option: Docker Desktop (with Docker Engine on Linux CI)**

Use Docker Desktop as the standard container runtime for local development on macOS/Windows, and Docker Engine on Linux-based CI runners. All team members install Docker Desktop and the project standardizes on the Docker CLI and Docker Compose v2.

### Rationale

1. **Development velocity** — The time spent debugging Podman/Colima compatibility issues was exceeding the cost of Docker Desktop licensing. Every hour spent on container runtime workarounds was an hour not spent on the product.
2. **Ecosystem alignment** — testcontainers, GitHub Actions runners, and `dockerode` (used by testcontainers internally) are built and tested against the Docker API. Docker is the path of least resistance.
3. **Reproducibility** — Docker Desktop provides identical behavior across macOS, Windows, and Linux. One set of Dockerfiles and Compose files works everywhere without translation or compatibility shims.
4. **CI parity** — GitHub Actions hosted runners ship with Docker Engine pre-installed. Using Docker locally guarantees local/CI behavioral parity.

### Trade-offs Accepted

- **Licensing cost** — Docker Desktop requires a paid subscription for commercial use in organizations with more than 250 employees or more than $10M annual revenue. The team accepts this cost as justified by the productivity gains.
- **Vendor lock-in** — Standardizing on Docker means Dockerfiles, Compose files, and CI workflows assume Docker semantics. Migrating to an alternative runtime later would require re-validation of the entire container surface.
- **Resource overhead on macOS** — Docker Desktop runs a Linux VM on macOS, consuming additional memory and CPU. This is a known trade-off of any container runtime on macOS.

## Consequences

### Positive

- **No more runtime debugging** — Eliminates the class of bugs caused by container runtime incompatibilities
- **Onboarding simplicity** — New developers install Docker Desktop and run `docker compose up`; no VM tuning, socket configuration, or compatibility shims
- **testcontainers works out of the box** — The topology container tests (`peering.orchestrator.topology.container.test.ts`, `transit.orchestrator.topology.container.test.ts`) run without runtime-specific workarounds
- **CI/local parity** — The same `docker build` and `docker compose` commands work identically in GitHub Actions and on developer machines
- **Community support** — Docker issues have the largest pool of Stack Overflow answers, documentation, and community tooling

### Negative

- **Recurring licensing cost** — Annual subscription cost per developer seat
- **macOS resource usage** — Docker Desktop VM consumes 2-4 GB RAM at idle; developers on resource-constrained machines may notice impact
- **Vendor dependency** — If Docker Inc. changes licensing terms again (as they did in 2021), the team would need to re-evaluate

### Neutral

- **No Dockerfile changes required** — Existing Dockerfiles are standard OCI-compatible; they would work with any runtime. The lock-in is in tooling and workflow, not image format.
- **Podman remains viable for future** — If Podman's Docker API compatibility matures (particularly testcontainers support and Docker Compose parity), this decision can be revisited with low switching cost.

## References

- [Docker Desktop Licensing FAQ](https://www.docker.com/pricing/faq/)
- [testcontainers Supported Container Runtimes](https://node.testcontainers.org/supported-container-runtimes/)
- [Podman Docker Compatibility](https://podman.io/docs)
- [Colima GitHub](https://github.com/abiosoft/colima)
- [GitHub Actions Runner Images (Docker pre-installed)](https://github.com/actions/runner-images)

---

## Appendix: Options Considered

<details>
<summary>Click to expand full options analysis</summary>

### Option 1: Docker Desktop

The industry-standard container runtime with native macOS/Windows support via a managed Linux VM.

**Approach:**

- Install Docker Desktop on all developer machines
- Use Docker Engine on Linux CI runners (GitHub Actions)
- Standardize on Docker CLI and Docker Compose v2

**Pros:**

- First-class testcontainers support
- Identical behavior across macOS, Windows, Linux
- GitHub Actions ships with Docker pre-installed
- Largest community, most documentation, best debuggability
- Docker Compose v2 built-in (no separate install)
- Integrated volume mounts, networking, DNS resolution

**Cons:**

- Commercial license required (paid subscription for qualifying organizations)
- VM overhead on macOS (~2-4 GB RAM idle)
- Vendor dependency on Docker Inc.

### Option 2: Podman (Rootless)

An open-source, daemonless container engine developed by Red Hat. OCI-compatible and designed as a drop-in Docker replacement.

**Approach:**

- Install Podman on developer machines
- Use `podman-compose` or Podman's built-in Docker Compose compatibility
- Configure `DOCKER_HOST` to point to Podman socket for testcontainers

**Pros:**

- Free and open-source (Apache 2.0)
- Rootless by default (better security posture)
- No daemon process required
- OCI-compatible (same image format)

**Cons:**

- testcontainers compatibility is experimental; `dockerode` socket compatibility issues observed
- `podman-compose` has feature gaps vs Docker Compose v2 (networking, depends_on conditions)
- Rootless networking behaves differently — container-to-container DNS resolution failed in topology tests
- macOS support requires a VM (Podman Machine) with its own set of mount and networking quirks
- Smaller community; fewer answers for debugging edge cases
- Team spent multiple days debugging socket and networking issues without resolution

### Option 3: Colima + Docker CLI

Colima provides a lightweight Lima-based VM on macOS that runs Docker Engine, allowing use of the free Docker CLI without Docker Desktop.

**Approach:**

- Install Colima and Docker CLI via Homebrew
- Colima manages the Linux VM; Docker CLI connects to it
- Use standard Docker Compose and testcontainers

**Pros:**

- Free (avoids Docker Desktop license)
- Uses real Docker Engine (full API compatibility in theory)
- Docker CLI and Compose work as expected in most cases
- Lower resource usage than Docker Desktop in some configurations

**Cons:**

- Lima VM layer introduced intermittent networking and mount issues on macOS
- DNS resolution between containers was unreliable in topology tests
- VM resource allocation (CPU, memory, disk) required manual tuning per machine
- Additional abstraction layer (Colima → Lima → QEMU → Docker Engine) made debugging harder
- Not available on Windows
- Colima is a community project with a smaller maintenance team
- Team spent significant time tuning VM settings and debugging network failures

### Option 4: Rancher Desktop

An open-source desktop application that provides Docker and Kubernetes on macOS, Windows, and Linux. This wasn't truly considered in depth. Decision fatigue.

**Approach:**

- Install Rancher Desktop with `dockerd` (Moby) backend
- Use Docker CLI compatibility layer

**Pros:**

- Free and open-source
- Provides both Docker and Kubernetes
- Available on macOS, Windows, Linux

**Cons:**

- Less mature than Docker Desktop; more frequent breaking changes
- testcontainers compatibility not extensively validated
- Adds Kubernetes complexity that the project doesn't need
- Smaller community than Docker Desktop or Podman
