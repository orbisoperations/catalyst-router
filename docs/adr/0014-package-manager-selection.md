# ADR-0014: Package Manager Selection (pnpm)

**Status:** Accepted
**Date:** 2026-02-18
**Decision Owner(s):** Engineering Team

## Context

The project is migrating from Bun to Node.js (ADR-0011). Bun ships its own built-in package manager (`bun install`, `bunx`) that is the current mechanism for dependency installation and workspace management. On Node.js a separate package manager must be chosen.

### Current State

The monorepo uses Bun's package manager exclusively:

| Surface              | Bun usage                                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Dependency install   | `bun install --omit=dev --ignore-scripts`                                                                             |
| Workspace definition | `"workspaces"` key in root `package.json`                                                                             |
| Catalog protocol     | `"catalog:"` and `"catalog:dev"` / `"catalog:testing"` in `package.json` `workspaces.catalog` / `workspaces.catalogs` |
| Script runner        | `bun run <script>`                                                                                                    |
| One-off execution    | `bunx <pkg>` (e.g., `bunx turbo run typecheck`)                                                                       |
| Dockerfiles          | `FROM oven/bun:1.3.6-alpine`; `RUN bun install`                                                                       |
| CI                   | `bun run lint`, `bunx turbo run test:unit`, etc.                                                                      |
| Lockfile             | `bun.lock` (binary format)                                                                                            |

### The Catalog Protocol Problem

The root `package.json` uses Bun's workspace catalog feature extensively:

```json
"workspaces": {
  "packages": ["apps/*", "packages/*", "examples/*"],
  "catalog": {
    "hono": "^4.11.3",
    "vitest": "^4.0.16",
    ...
  },
  "catalogs": {
    "dev": { "typescript": "^5.9.3", ... },
    "testing": { "vitest": "^4.0.16", ... }
  }
}
```

Individual packages reference these with `"catalog:"`, `"catalog:dev"`, `"catalog:testing"`. This protocol pins shared dependency versions in one place, preventing version drift across 15+ packages.

**Not all package managers support this protocol:**

| Package manager | Catalog protocol support                                                                |
| --------------- | --------------------------------------------------------------------------------------- |
| pnpm 9+         | Yes — native `pnpm-workspace.yaml` with `catalog:` and named `catalogs:`                |
| npm             | No — no catalog protocol; all versions must be spelled out in each `package.json`       |
| yarn berry (v4) | No — no equivalent; uses `resolutions` for overrides, not cross-package version sharing |

Migrating to a package manager without catalog support would require flattening every `"catalog:dev"` reference back to an explicit version in each of the ~15 workspace `package.json` files — a significant and ongoing maintenance burden.

### Requirements

| Requirement                                 | Priority | Notes                                      |
| ------------------------------------------- | -------- | ------------------------------------------ |
| Works on Node.js                            | Must     | Migration target runtime                   |
| Supports catalog protocol                   | Must     | Avoid reflattening 15+ package.json files  |
| Workspace protocol (`workspace:*`) support  | Must     | Used for cross-package dependencies        |
| Lockfile reproducibility                    | Must     | Deterministic installs in CI and Docker    |
| pnpm install in Docker (Alpine)             | Must     | All service Dockerfiles use Alpine         |
| Compatible with Turborepo                   | Should   | CI uses `turbo run` for task orchestration |
| Fast installs via content-addressable store | Should   | Developer experience                       |
| Familiar to Node.js ecosystem               | Should   | Team onboarding                            |

## Decision

**Chosen Option: pnpm 9**

Adopt pnpm 9 as the package manager, replacing Bun's built-in package manager. pnpm is the only package manager that natively supports the catalog protocol already used in `package.json`, making it the path of least resistance for the migration.

### Rationale

1. **Native catalog protocol support** — pnpm 9 introduced native `catalog:` and named `catalogs:` support in `pnpm-workspace.yaml`. This maps directly to the Bun workspace catalog already in use. No package.json files need their version specifiers changed.

2. **Minimal workspace config change** — The workspace definition moves from `"workspaces"` in `package.json` to `pnpm-workspace.yaml`, but the content is structurally identical. The catalog entries move verbatim.

3. **`workspace:*` protocol** — pnpm invented the `workspace:` protocol (adopted by Bun and yarn). Cross-package refs like `"@catalyst/service": "workspace:*"` require no changes.

4. **Content-addressable store** — pnpm uses a global content-addressable store with hard links. Install time is fast after the first run (packages already in the store are not re-downloaded). Docker layer caching benefits from this.

5. **Turborepo compatibility** — Turborepo supports pnpm workspaces natively. CI workflows using `turbo run typecheck` / `turbo run test:unit` continue to work with `pnpm exec turbo` replacing `bunx turbo`.

6. **Node.js ecosystem standard** — pnpm is widely adopted in the Node.js monorepo ecosystem and has first-class support in GitHub Actions (`pnpm/action-setup`).

### Workspace Configuration Migration

The Bun workspace config in `package.json`:

```json
"workspaces": {
  "packages": ["apps/*", "packages/*", "examples/*"],
  "catalog": {
    "hono": "^4.11.3",
    ...
  },
  "catalogs": {
    "dev": { "typescript": "^5.9.3", ... },
    "testing": { "vitest": "^4.0.16", ... }
  }
}
```

Becomes `pnpm-workspace.yaml`:

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - 'examples/*'

catalog:
  hono: ^4.11.3
  graphql: 16.12.0
  # ... (all entries from the default catalog)

catalogs:
  dev:
    typescript: ^5.9.3
    '@types/node': ^25.0.3
    # ...
  testing:
    vitest: ^4.0.16
    '@vitest/coverage-v8': ^4.0.16
    # ...
```

The `"workspaces"` key in `package.json` is replaced with a simple `"packageManager"` field:

```json
"packageManager": "pnpm@9.x.x"
```

Individual package `package.json` files referencing `"catalog:"`, `"catalog:dev"`, `"catalog:testing"` require **no changes** — pnpm reads the same protocol from `pnpm-workspace.yaml`.

### Command Migration Map

| Bun command                     | pnpm equivalent                                 |
| ------------------------------- | ----------------------------------------------- |
| `bun install`                   | `pnpm install`                                  |
| `bun install --omit=dev`        | `pnpm install --prod`                           |
| `bun install --frozen-lockfile` | `pnpm install --frozen-lockfile`                |
| `bun install --ignore-scripts`  | `pnpm install --ignore-scripts`                 |
| `bun add <pkg>`                 | `pnpm add <pkg>`                                |
| `bun add -D <pkg>`              | `pnpm add -D <pkg>`                             |
| `bun run <script>`              | `pnpm run <script>` (or `pnpm <script>`)        |
| `bunx <pkg>`                    | `pnpm exec <pkg>` or `pnpm dlx <pkg>` (one-off) |
| `bunx turbo run <task>`         | `pnpm exec turbo run <task>`                    |

### Lockfile

`bun.lock` (Bun's binary lockfile format) is replaced by `pnpm-lock.yaml` (YAML, human-readable). The `bun.lock` file should be deleted from the repository; `pnpm-lock.yaml` is committed in its place.

### Docker Migration

Dockerfiles change from the Bun image to Node.js with pnpm installed via corepack:

```dockerfile
# Before
FROM oven/bun:1.3.6-alpine AS deps
RUN bun install --omit=dev --ignore-scripts

# After
FROM node:22-alpine AS deps
RUN corepack enable && corepack prepare pnpm@latest --activate
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
```

Copy `pnpm-workspace.yaml` alongside `package.json` in the deps stage, as pnpm requires it for workspace resolution:

```dockerfile
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
```

### CI Migration

GitHub Actions workflows replace Bun setup with `pnpm/action-setup`:

```yaml
# Before
- uses: oven-sh/setup-bun@v2
  with:
    bun-version: 1.3.6

# After
- uses: pnpm/action-setup@v4
  with:
    version: 9
- uses: actions/setup-node@v4
  with:
    node-version: 22
    cache: 'pnpm'
```

CI scripts update from `bun run` / `bunx` to `pnpm run` / `pnpm exec`:

```yaml
# Before
- run: bun run lint
- run: bunx turbo run typecheck

# After
- run: pnpm run lint
- run: pnpm exec turbo run typecheck
```

### Trade-offs Accepted

- **New lockfile** — `bun.lock` is replaced by `pnpm-lock.yaml`. All developers must re-run `pnpm install` after switching. There is no migration path between lockfile formats; dependency resolution restarts from the version ranges in `package.json`.
- **`pnpm-workspace.yaml` is a new file** — The workspace definition moves out of `package.json` into a new file. Both must be present at the repo root for pnpm to function correctly.
- **Strict by default** — pnpm's default hoisting behavior is stricter than npm's: packages cannot access undeclared dependencies by accident. This is a correctness improvement but may surface phantom dependencies that were silently working under Bun's flat `node_modules`.
- **Developer machine setup** — All developers must install pnpm (via `corepack enable` + `corepack prepare pnpm@9`). The `"packageManager"` field in `package.json` enables corepack to enforce the correct version automatically.

## Consequences

### Positive

- Catalog protocol is preserved exactly — no `package.json` version churn across 15+ workspace packages.
- `workspace:*` protocol requires zero changes.
- pnpm's strict hoisting catches phantom dependency usage that could break at runtime.
- Content-addressable store speeds up repeated installs across branches and CI runs.
- `pnpm-lock.yaml` is human-readable YAML — easier to review in pull requests than `bun.lock`'s binary format.
- GitHub Actions `pnpm/action-setup` + `cache: 'pnpm'` in `setup-node` provides automatic lockfile-based caching.

### Negative

- `bun.lock` is incompatible with pnpm — the lockfile must be regenerated fresh. Initial `pnpm install` will re-resolve all versions from scratch.
- `pnpm-workspace.yaml` is a new file to maintain alongside `package.json`. Both must be kept in sync.
- Strict hoisting may surface phantom dependencies: packages that work today because of Bun's flat `node_modules` might fail with pnpm until their `package.json` declares the dependency explicitly.
- All Dockerfiles, CI workflows, shell scripts, and documentation that reference `bun install` / `bunx` must be updated.

### Neutral

- Script runner semantics are unchanged: `pnpm run build` behaves identically to `bun run build`. Scripts defined in `package.json` require no changes.
- `resolutions` in root `package.json` (currently used for `graphql: 16.12.0`) becomes `pnpm.overrides` — same intent, different key name.
- The `@types/bun` devDependency in the `dev` catalog becomes unused and should be removed.

## Implementation

### Phase 1: Workspace config

1. Create `pnpm-workspace.yaml` at the repo root with all `packages`, `catalog`, and `catalogs` entries from the current `package.json` `workspaces` key.
2. Remove the `workspaces` key from root `package.json`.
3. Add `"packageManager": "pnpm@9.x.x"` to root `package.json`.
4. Change `"resolutions"` key to `"pnpm": { "overrides": { ... } }` in root `package.json`.
5. Delete `bun.lock` from the repository.
6. Run `pnpm install` to generate `pnpm-lock.yaml`.
7. Remove `@types/bun` from the `dev` catalog.

### Phase 2: Dockerfiles

Update all service Dockerfiles (`apps/auth`, `apps/gateway`, `apps/orchestrator`, `apps/envoy`) and example Dockerfiles:

```dockerfile
FROM node:22-alpine AS deps

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# pnpm requires workspace config alongside package.json
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/auth/package.json apps/auth/package.json
# ... (all other workspace package.json files)

RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:22-alpine

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
# ... (workspace package.json files and source)

RUN pnpm install --prod --frozen-lockfile --ignore-scripts
```

### Phase 3: CI workflows

Update `.github/workflows/ci.yml` and any composite actions under `.github/actions/`:

```yaml
- uses: pnpm/action-setup@v4
  with:
    version: 9
- uses: actions/setup-node@v4
  with:
    node-version: 22
    cache: 'pnpm'
- run: pnpm install --frozen-lockfile
```

Replace `bun run` with `pnpm run` and `bunx` with `pnpm exec` throughout workflows.

### Phase 4: Root scripts and documentation

Update root `package.json` scripts that use `bun run` as a script runner (e.g., `"compile:all:docker": "bun run compile:auth:docker && ..."` → `"pnpm run compile:auth:docker && ..."`).

Update `CONTRIBUTING.md`, `docker-compose/DEMO.md`, and other developer-facing documentation to reference `pnpm install` and `pnpm run` instead of `bun install` and `bun run`.

## Risks and Mitigations

| Risk                                                         | Likelihood | Impact | Mitigation                                                                                |
| ------------------------------------------------------------ | ---------- | ------ | ----------------------------------------------------------------------------------------- |
| Phantom dependency failures after strict hoisting            | Medium     | Medium | Audit missing declarations with `pnpm why <pkg>`; add explicit deps as found              |
| Docker build fails due to missing `pnpm-workspace.yaml` COPY | High       | High   | Template Dockerfile includes `COPY pnpm-workspace.yaml`; add to Docker build smoke tests  |
| Lockfile regeneration resolves to different patch versions   | Low        | Low    | Review `pnpm-lock.yaml` diff after first generation; pin critical packages if needed      |
| Developer machines missing pnpm                              | Medium     | Low    | `"packageManager"` field + corepack enforces correct version; document in CONTRIBUTING.md |
| CI cache miss on first run after migration                   | Low        | Low    | Expected; cache warms after first successful run on each branch                           |

## Related Decisions

- ADR-0011 — Node.js runtime adoption; the direct motivation for this decision
- [ADR-0013](./0013-test-runner-selection.md) — Test runner selection (Vitest); pnpm runs Vitest scripts via `pnpm run test`
- [ADR-0005](./0005-docker-as-container-runtime.md) — Docker as container runtime; Dockerfiles must be updated to use pnpm

## References

- [pnpm workspace catalog documentation](https://pnpm.io/catalogs)
- [pnpm workspace configuration](https://pnpm.io/pnpm-workspace_yaml)
- [pnpm/action-setup GitHub Action](https://github.com/pnpm/action-setup)
- [corepack documentation](https://nodejs.org/api/corepack.html)
- [Turborepo pnpm support](https://turbo.build/repo/docs/getting-started/existing-monorepo#install-turbo)

---

## Appendix: Options Considered

<details>
<summary>Click to expand full options analysis</summary>

### Decision Drivers

- **Catalog protocol** — The existing workspace already uses `catalog:` specifiers across 15+ `package.json` files. A package manager that doesn't support this protocol forces flattening all catalog refs to explicit versions — significant churn and ongoing maintenance cost.
- **Workspace protocol** — `workspace:*` refs must be supported.
- **Node.js compatibility** — Must work as a standalone package manager on Node.js.
- **Docker / CI integration** — Must work in Alpine-based Docker builds and GitHub Actions.
- **Turborepo compatibility** — CI uses Turborepo for task orchestration.

### Option 1: pnpm 9 (chosen)

A fast, disk-efficient package manager with a content-addressable store and first-class workspace support.

**Approach:**

- Move workspace definition from `package.json` `workspaces` key to `pnpm-workspace.yaml`
- Catalog and catalogs entries move verbatim to `pnpm-workspace.yaml`
- Replace `bun install` with `pnpm install`, `bunx` with `pnpm exec`
- Install via corepack in Docker (`corepack enable && corepack prepare pnpm@latest`)

**Pros:**

- Native catalog protocol support (pnpm 9+) — zero changes to individual `package.json` files
- `workspace:*` protocol is a pnpm original — full support
- Content-addressable store speeds up installs significantly after first run
- `pnpm-lock.yaml` is YAML, human-readable in PRs (vs binary `bun.lock`)
- pnpm strict hoisting catches phantom dependencies that could silently break
- First-class GitHub Actions support (`pnpm/action-setup`)
- Turborepo supports pnpm workspaces natively

**Cons:**

- `pnpm-workspace.yaml` is a new file to introduce and maintain
- Strict hoisting may surface phantom dependencies that need explicit declarations
- All Dockerfiles, CI files, and docs referencing `bun install`/`bunx` must be updated

### Option 2: npm (Node.js built-in)

The default package manager shipped with Node.js.

**Approach:**

- Remove `workspaces.catalog` from `package.json`; replace all `"catalog:"` specifiers with explicit version strings in every `package.json`
- Use npm workspaces (native `"workspaces"` array in `package.json`)
- Replace `bun install` with `npm install`, `bunx` with `npx`

**Pros:**

- Built into Node.js — no additional installation step
- Zero new tooling to learn
- Universal availability on any Node.js environment

**Cons:**

- **No catalog protocol support** — all `"catalog:"`, `"catalog:dev"`, `"catalog:testing"` specifiers across 15+ packages must be replaced with explicit version strings. This is ~100 package.json edits and reintroduces version drift risk.
- npm workspaces uses flat `node_modules` hoisting — weaker isolation than pnpm
- `package-lock.json` can be very large for monorepos
- Slower installs than pnpm (no content-addressable store)
- npm does not support the `workspace:` protocol — cross-package references using `"workspace:*"` must change to `"*"` or explicit versions

**Verdict:** Rejected. The catalog protocol incompatibility creates too much churn and eliminates the version-centralization benefit that the catalog provides.

### Option 3: Yarn Berry (v4)

The modern Yarn with Plug'n'Play (PnP) or node-modules linker.

**Approach:**

- Configure with `nodeLinker: node-modules` (to avoid PnP compatibility issues)
- Replace `bun install` with `yarn install`, `bunx` with `yarn dlx`
- Use Yarn's `resolutions` field for version overrides

**Pros:**

- Workspace support is mature
- Zero-install (PnP mode) enables committing dependencies to the repo
- `yarn dlx` is equivalent to `bunx`

**Cons:**

- **No catalog protocol support** — same flattening problem as npm; all `"catalog:"` specifiers must be replaced with explicit versions
- PnP mode has compatibility issues with some native addons and tooling
- node-modules linker mode gives up pnpm's strict hoisting benefits
- Yarn Berry has a separate toolchain (`yarn set version berry`, `.yarnrc.yml`) that adds configuration overhead
- Less common in modern Node.js monorepos than pnpm for this use case

**Verdict:** Rejected. No catalog support, and the additional configuration overhead of Yarn Berry offers no advantage over pnpm here.

### Option 4: Keep Bun package manager, use Node.js only for runtime

Decouple the package manager from the runtime: use Bun solely for `bun install` during CI and Docker builds, while running the application itself with Node.js.

**Approach:**

- Keep `oven/bun` image only in the `deps` stage of Dockerfiles for `bun install`
- Switch the runtime stage to `node:22-alpine`
- Continue using `bun install` in CI

**Pros:**

- No catalog migration required
- No lockfile change
- Fewer files to update

**Cons:**

- Requires Bun to be installed in CI even after the Node.js migration — two runtimes to maintain
- Docker builds become more complex (Bun image for deps stage, Node image for runtime stage with cross-stage `COPY`)
- Creates a confusing hybrid state that would need to be cleaned up later
- Bun package manager behavior is not identical to Node.js package managers — resolution differences can surface in production
- Locks us into maintaining Bun as a dependency indefinitely

**Verdict:** Rejected. A clean cut to pnpm is less complex than a long-lived hybrid that maintains Bun as a build-time dependency.

</details>
