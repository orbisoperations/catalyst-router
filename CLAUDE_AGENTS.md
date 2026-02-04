# CLAUDE_AGENTS.md - Subagent Strategy for Catalyst Node

This document defines the subagent strategy for AI-assisted development on Catalyst Node. It describes each agent's purpose, when to use it, and provides prompt templates for maximum effectiveness.

## Philosophy

**Documentation-First Development:** Before writing any code, we understand the existing context—stack scope, documentation, and ADRs. This prevents wasted effort and ensures changes align with established patterns.

**Parallel Where Possible, Sequential Where Required:** Research and exploration agents run in parallel. Verification agents run sequentially (fail-fast).

**Living Documentation:** Agents don't just consume docs—they help keep them current. Every implementation should consider whether docs need updates.

---

## Agent Catalog

### 1. Stack Scope Agent

**Purpose:** Understand the current Graphite stack before making changes.

**When to Use:**

- At the start of any implementation task
- Before deciding what files to modify
- When reviewing someone else's stack

**Objective:** Determine what's in scope for the current PR to keep changes focused and avoid scope creep.

**Agent Type:** `Explore`

**Prompt Template:**

```
Analyze the current Graphite stack scope for this repository.

Run `gt log short` and `gt stack` to understand:
1. What branch am I currently on?
2. What PRs are in my current stack (below and above)?
3. What is the intent/theme of the current PR based on its name?
4. What files have been modified in this specific PR (not the whole stack)?

Based on this, tell me:
- What the scope boundaries are for this PR
- What changes would be IN scope vs OUT of scope
- If I should consider splitting work into additional stacked PRs
```

**Example Output:**

```
Current Branch: jt/feat-add-token-rotation
Stack Position: 2 of 3

Stack Structure:
  ┌─ jt/feat-add-revocation-ui (above)
  ├─ jt/feat-add-token-rotation (current) ← YOU ARE HERE
  └─ jt/refactor-auth-stores (below, merged to main)

Current PR Scope:
- Modified: packages/auth/src/token-manager.ts
- Modified: packages/auth/src/rpc/schema.ts
- Added: packages/auth/tests/rotation.test.ts

In Scope: Token rotation logic, rotation RPC endpoint, rotation tests
Out of Scope: UI changes (belongs in PR above), store refactoring (already in PR below)

Recommendation: Keep changes focused on rotation mechanism. Any revocation-related
changes should go in the PR above.
```

---

### 2. Documentation Agent

**Purpose:** Read and synthesize relevant documentation before implementation.

**When to Use:**

- Before any implementation work
- When touching unfamiliar parts of the codebase
- When the task involves architecture or security

**Objective:** Understand documented intent so changes reinforce (or deliberately update) existing patterns.

**Agent Type:** `Explore`

**Prompt Template:**

```
Read the documentation relevant to [TASK DESCRIPTION].

Check these docs based on the task area:
- ARCHITECTURE.md - If touching system design, component interactions
- SECURITY.md - If touching auth, crypto, peering, tokens
- BGP_PROTOCOL.md - If touching peering, routing, propagation
- TECH_STACK.md - If choosing libraries or patterns
- packages/[name]/README.md - For package-specific context

For each relevant doc, extract:
1. Key patterns or requirements that apply to this task
2. Any constraints or "don't do this" guidance
3. Existing terminology I should use consistently
4. Open questions or areas marked as TODO

Summarize what I need to know before implementing [TASK DESCRIPTION].
```

**Example Prompt:**

```
Read the documentation relevant to adding a new RPC endpoint for key rotation.

Check SECURITY.md, ARCHITECTURE.md, and packages/auth/README.md.

Extract patterns for:
- How RPC endpoints are structured
- Security requirements for key management
- Any existing key rotation documentation
```

---

### 3. ADR Compliance Agent

**Purpose:** Ensure implementation follows Architecture Decision Records.

**When to Use:**

- Before any implementation (part of pre-work phase)
- When touching areas covered by ADRs (observability, storage, auth)
- When proposing a new technical approach

**Objective:** Follow established decisions. If deviating, propose an ADR amendment.

**Agent Type:** `Explore`

**Prompt Template:**

```
Check ADR compliance for [TASK DESCRIPTION].

Read all ADRs in docs/adr/ and identify:
1. Which ADRs are relevant to this task?
2. What specific requirements do they impose?
3. Does my planned approach comply with these ADRs?
4. If not, what would need to change—my approach or the ADR?

ADRs to check:
- ADR-0001: OpenTelemetry (if adding logging, metrics, traces)
- ADR-0002: LogTape logging (if adding any logging)
- ADR-0003: Observability backends (if adding monitoring)
- ADR-0004: SQLite storage (if adding persistence)
- ADR-0007: Certificate-bound tokens (if touching JWT/peering)
- ADR-0008: Cerbos authorization (if adding access control)

Report:
- Compliant: [list of ADRs and how we comply]
- Non-compliant: [list of ADRs and what's wrong]
- Recommendations: [changes needed or ADR amendments to propose]
```

**Example Prompt:**

```
Check ADR compliance for adding user activity logging to the auth service.

I plan to use console.log for debugging and store logs in a JSON file.

Check ADR-0001, ADR-0002, and ADR-0004 to see if this approach is compliant.
```

**Example Output:**

```
❌ Non-Compliant with ADR-0002 (Logging Library Selection)
   Issue: Using console.log instead of LogTape
   Required: Use LogTape with template literals
   Fix: import { getLogger } from '@catalyst/telemetry'
        const logger = getLogger(['auth', 'activity'])
        logger.info`User ${userId} performed ${action}`

❌ Non-Compliant with ADR-0004 (SQLite Storage)
   Issue: Storing logs in JSON file instead of SQLite
   Required: All persistent state must use SQLite
   Fix: Create ActivityLogStore with SqliteStore implementation

✅ Compliant with ADR-0001 if using @catalyst/telemetry

Recommendation: Refactor to use LogTape + SQLite. No ADR changes needed.
```

---

### 4. Verification Agent

**Purpose:** Run the full verification chain after implementation.

**When to Use:**

- After completing implementation
- Before committing changes
- When CI fails and you need to reproduce locally

**Objective:** Catch issues early with clear failure reporting.

**Agent Type:** `Bash`

**Prompt Template:**

```
Run the verification chain for changes in [PACKAGES].

Execute in order, stopping on first failure:
1. bun run lint
2. bun run format:check
3. tsc --noEmit
4. bun test [package1] & bun test [package2] (parallel OK)
5. Integration tests if cross-package changes
6. Container tests if RPC/networking changes (needs CATALYST_CONTAINER_TESTS_ENABLED=true)

For any failures, report:
- Which step failed
- Which package(s) affected
- Specific file and line if available
- The actual error message
- Suggested fix if obvious

Format failures as:
❌ [step]: [package]
   File: [path]
   Error: [message]
   Suggestion: [fix]
```

**Example Prompt:**

```
Run the verification chain for changes in @catalyst/auth and @catalyst/gateway.

I modified the token signing logic and the gateway's token verification.
Run lint, typecheck, and unit tests for both packages in parallel.
```

**Example Output:**

```
✅ Lint: passed
✅ Format: passed
✅ TypeScript: passed

Running tests in parallel...

❌ @catalyst/auth: 1 failure
   File: packages/auth/tests/sign-token.test.ts:47
   Error: Expected cnf claim to be present in token
   Suggestion: Add cnf claim generation in signToken() per ADR-0007

✅ @catalyst/gateway: all tests passed

Summary: 1 failure in auth package. Fix cnf claim handling before commit.
```

---

### 5. Cross-Package Impact Agent

**Purpose:** Assess ripple effects when changing shared code.

**When to Use:**

- When modifying `@catalyst/config` schemas
- When changing RPC interfaces
- When updating shared types or utilities
- When changing `@catalyst/sdk` public API

**Objective:** Find all affected code before changes break downstream packages.

**Agent Type:** `Explore`

**Prompt Template:**

```
Analyze cross-package impact for changes to [FILE/SYMBOL].

1. Find all imports of this file/symbol across packages
2. Find all usages of affected types/functions
3. Identify which packages would need updates
4. Check if any tests would break
5. Check if any docs reference this

Report:
- Direct dependents: [packages that import this]
- Transitive dependents: [packages that depend on direct dependents]
- Breaking changes: [what would break and where]
- Required updates: [files that need modification]
- Test coverage: [which tests exercise this code]
```

**Example Prompt:**

```
Analyze cross-package impact for changes to CatalystConfigSchema in @catalyst/config.

I'm adding a new required field 'telemetryEndpoint' to the config schema.

Find everywhere this schema is used and what would break.
```

**Example Output:**

```
Direct Dependents:
- @catalyst/node (imports loadDefaultConfig)
- @catalyst/auth (imports AuthConfigSchema)
- @catalyst/orchestrator (imports OrchestratorConfigSchema)
- @catalyst/cli (imports CatalystConfigSchema for validation)

Breaking Changes:
- packages/node/src/index.ts:23 - loadDefaultConfig() will fail without env var
- packages/cli/src/commands/init.ts:45 - Config validation will reject existing configs
- docker-compose/m0p2.yml - Missing CATALYST_TELEMETRY_ENDPOINT env var

Required Updates:
1. Add CATALYST_TELEMETRY_ENDPOINT to all docker-compose files
2. Update CLI init command to prompt for telemetry endpoint
3. Add telemetryEndpoint to example configs in docs/
4. Update @catalyst/config README with new field

Test Coverage:
- packages/config/tests/schema.test.ts - Add test for new field
- packages/node/tests/config.test.ts - Will fail, needs update
```

---

### 6. Doc Sync Agent

**Purpose:** Check if documentation needs updates after implementation.

**When to Use:**

- After completing implementation
- Before finalizing a PR
- When adding new features or changing behavior

**Objective:** Keep documentation current with code changes.

**Agent Type:** `Explore`

**Prompt Template:**

```
Check if documentation needs updates after [CHANGES MADE].

Review:
1. Does CLAUDE.md need pattern updates?
2. Do any ADRs need amendments?
3. Does ARCHITECTURE.md need updates?
4. Do package READMEs need updates?
5. Are there inline code comments that are now stale?

For each doc that needs updates:
- What section needs changing?
- What should be added/modified/removed?
- Draft the specific changes

Also check:
- Did we establish a new pattern that should be in CLAUDE.md?
- Did we deviate from an ADR that needs amendment?
- Should we create a new ADR for this decision?
```

**Example Prompt:**

```
Check if documentation needs updates after adding certificate-bound token support.

Changes made:
- Added cnf claim to JWT generation
- Added certificate thumbprint verification in token validation
- Added new RPC endpoint: bindCertificate()

Check SECURITY.md, CLAUDE.md, packages/auth/README.md, and ADR-0007.
```

---

## Workflow Integration

### Standard Task Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        PRE-WORK PHASE                           │
│  (Run in parallel)                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ Stack Scope  │  │Documentation │  │ADR Compliance│          │
│  │    Agent     │  │    Agent     │  │    Agent     │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     IMPLEMENTATION PHASE                         │
│  - Stay within stack scope                                       │
│  - Follow documented patterns                                    │
│  - Comply with ADRs                                             │
│  - Use Cross-Package Impact Agent if touching shared code       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     VERIFICATION PHASE                           │
│  (Sequential - stop on failure)                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Verification Agent: lint → format → types → tests        │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      DOC SYNC PHASE                              │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Doc Sync Agent: Check for needed documentation updates    │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Prompt Writing Best Practices

**1. Be Specific About Scope**

```
❌ Bad:  "Check the docs"
✅ Good: "Read SECURITY.md and ADR-0007, focusing on JWT claim requirements
         for the token rotation feature I'm implementing"
```

**2. State Your Intent**

```
❌ Bad:  "What does the auth package do?"
✅ Good: "I need to add a token rotation endpoint. What existing patterns
         in @catalyst/auth should I follow for RPC endpoints?"
```

**3. Provide Context**

```
❌ Bad:  "Run the tests"
✅ Good: "Run tests for @catalyst/auth after I modified signToken() to
         include the cnf claim. Focus on token signing and verification tests."
```

**4. Request Actionable Output**

```
❌ Bad:  "Is this ADR compliant?"
✅ Good: "Check ADR-0002 compliance for my logging approach. If non-compliant,
         provide the specific code changes needed to fix it."
```

**5. Chain Agents Logically**

```
✅ Good workflow:
   1. Stack Scope Agent → Know what's in scope
   2. Documentation Agent → Understand patterns (informed by scope)
   3. ADR Compliance Agent → Verify approach (informed by docs)
   4. [Implementation]
   5. Cross-Package Impact Agent → If I touched shared code
   6. Verification Agent → Run checks
   7. Doc Sync Agent → Update docs if needed
```

---

## Example Scenarios

### Scenario 1: Adding a New RPC Endpoint

**Task:** Add `rotateKey()` RPC endpoint to auth service

**Agent Sequence:**

```
1. Stack Scope Agent:
   "What's the scope of my current PR? I want to add a key rotation endpoint."

2. Documentation + ADR Agents (parallel):
   - "Read SECURITY.md for key rotation requirements"
   - "Check ADR-0007 for certificate-bound token implications on key rotation"

3. [Implement the endpoint following patterns discovered]

4. Verification Agent:
   "Run verification for @catalyst/auth. I added rotateKey() RPC endpoint."

5. Doc Sync Agent:
   "Check if SECURITY.md or packages/auth/README.md need updates for the
    new rotateKey() endpoint."
```

### Scenario 2: Modifying Shared Config Schema

**Task:** Add `telemetry.samplingRate` to CatalystConfigSchema

**Agent Sequence:**

```
1. Cross-Package Impact Agent:
   "I'm adding telemetry.samplingRate to CatalystConfigSchema.
    Find all packages that would be affected."

2. ADR Compliance Agent:
   "Check if adding telemetry config aligns with ADR-0001 OpenTelemetry strategy."

3. [Implement changes across all affected packages]

4. Verification Agent:
   "Run verification for @catalyst/config, @catalyst/node, @catalyst/auth,
    and @catalyst/orchestrator. I modified the shared config schema."

5. Doc Sync Agent:
   "Check if CLAUDE.md environment variables section needs the new
    CATALYST_TELEMETRY_SAMPLING_RATE variable documented."
```

### Scenario 3: Investigating a Test Failure

**Task:** CI failed on topology tests

**Agent Sequence:**

```
1. Stack Scope Agent:
   "What changes are in my current stack that might affect topology tests?"

2. Verification Agent:
   "Run topology tests locally with verbose output.
    Focus on packages/orchestrator topology tests."

3. Documentation Agent:
   "Read ARCHITECTURE.md section on orchestrator topology and
    BGP_PROTOCOL.md to understand expected behavior."

4. [Fix the issue]

5. Verification Agent:
   "Re-run full verification chain to confirm the fix."
```

---

## Maintaining This Document

This document should evolve as we learn what works:

1. **Add new agents** when recurring patterns emerge
2. **Refine prompts** based on what produces best results
3. **Add scenarios** for common task types
4. **Remove/update** agents that aren't useful

When updating, also check if CLAUDE.md's Subagent Strategy section needs corresponding updates.
