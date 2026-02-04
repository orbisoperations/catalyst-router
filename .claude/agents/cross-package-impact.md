---
name: Cross-Package Impact
description: Assess ripple effects of shared code changes
---

# Cross-Package Impact Agent

## Description

Assess ripple effects when changing shared code. Finds all affected packages and files before changes break downstream dependencies.

## Agent Type

Explore

## When to Use

- When modifying `@catalyst/config` schemas
- When changing RPC interfaces
- When updating shared types or utilities
- When changing `@catalyst/sdk` public API

## Prompt

```
Analyze cross-package impact for changes to: [FILE_OR_SYMBOL]

Planned change: [DESCRIPTION_OF_CHANGE]

Search and analyze:

1. Direct Imports
   Find all files that import this file/symbol:
   - grep for import statements
   - Check re-exports in index files

2. Usage Analysis
   For each import, find:
   - How the symbol is used
   - Whether the usage would break with the planned change

3. Package Dependencies
   Identify:
   - Direct dependents (packages that import this)
   - Transitive dependents (packages that depend on direct dependents)

4. Test Coverage
   Find tests that exercise this code:
   - Unit tests in the same package
   - Integration tests across packages

5. Documentation References
   Check if any docs reference this:
   - README files
   - ARCHITECTURE.md
   - API documentation

Report:
- Direct Dependents: [list with file paths]
- Transitive Dependents: [list]
- Breaking Changes: [what would break and where]
- Required Updates: [files needing modification]
- Test Coverage: [tests that need updates]
- Doc Updates: [documentation needing changes]
```

## Example Usage

**Prompt:**

```
Analyze cross-package impact for changes to CatalystConfigSchema in @catalyst/config.
I'm adding a new required field 'telemetryEndpoint' to the config schema.
```

**Expected Output:**

```
Cross-Package Impact Analysis
=============================

Change: Adding required field 'telemetryEndpoint' to CatalystConfigSchema

Direct Dependents (4 packages):
- @catalyst/node
  - packages/node/src/index.ts:12 - imports loadDefaultConfig
  - packages/node/src/config.ts:5 - imports CatalystConfigSchema
- @catalyst/auth
  - packages/auth/src/index.ts:3 - imports AuthConfigSchema (extends base)
- @catalyst/orchestrator
  - packages/orchestrator/src/config.ts:2 - imports OrchestratorConfigSchema
- @catalyst/cli
  - packages/cli/src/commands/init.ts:8 - imports CatalystConfigSchema

Breaking Changes:
❌ packages/node/src/index.ts:23
   loadDefaultConfig() will throw if CATALYST_TELEMETRY_ENDPOINT not set

❌ packages/cli/src/commands/init.ts:45
   Config validation will reject existing configs without telemetryEndpoint

❌ docker-compose/m0p2.yml
   Missing CATALYST_TELEMETRY_ENDPOINT environment variable

❌ examples/basic-config.json
   Example config missing new required field

Required Updates:
1. Add CATALYST_TELEMETRY_ENDPOINT to:
   - docker-compose/m0p2.yml
   - docker-compose/dev.yml
   - .env.example

2. Update CLI init command:
   - packages/cli/src/commands/init.ts - prompt for telemetry endpoint

3. Update example configs:
   - examples/basic-config.json
   - docs/configuration.md

4. Consider making field optional with default:
   - telemetryEndpoint: z.string().default('http://localhost:4317')

Test Coverage:
- packages/config/tests/schema.test.ts - needs test for new field
- packages/node/tests/config.test.ts - will fail, needs env var in setup
- packages/cli/tests/init.test.ts - needs updated fixtures

Documentation Updates:
- CLAUDE.md: Add to Environment Variables section
- packages/config/README.md: Document new field
```
