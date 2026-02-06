# Pre-Work Agent (Composite)

## Description

Runs the full pre-work phase by spawning Stack Scope, Documentation, and ADR Compliance agents in parallel. This is the standard entry point before any implementation work.

## Agent Type

Explore (spawns sub-agents)

## When to Use

- At the very start of any implementation task
- Before writing any code
- When picking up a new ticket or task

## Prompt

```
Run the Pre-Work phase for: [TASK_DESCRIPTION]

Execute these agents in PARALLEL:

1. Stack Scope Agent
   Understand the current Graphite stack and PR boundaries.
   What's in scope for this PR?

2. Documentation Agent
   Read relevant documentation for this task.
   What patterns and constraints apply?

3. ADR Compliance Agent
   Check which ADRs are relevant.
   Does our planned approach comply?

After all agents complete, synthesize:

Summary:
- Stack Scope: [in-scope vs out-of-scope items]
- Key Patterns: [patterns we must follow]
- ADR Requirements: [specific requirements from ADRs]
- Constraints: [things we cannot do]
- Recommendations: [suggested approach]

Ready to Implement:
- [ ] Scope is clear and focused
- [ ] Patterns are understood
- [ ] ADRs are satisfied
- [ ] No blocking questions

If any checkbox is unchecked, explain what needs resolution before proceeding.
```

## Example Usage

**Prompt:**

```
Run Pre-Work for: Add token rotation endpoint to auth service
```

**Expected Output:**

```
Pre-Work Phase Complete
=======================

Stack Scope (via Stack Scope Agent):
✅ Current branch: jt/feat-token-rotation
✅ Scope: Token rotation logic in @catalyst/auth only
⚠️ Out of scope: UI for rotation (separate PR), key storage changes (done in base)

Documentation (via Documentation Agent):
Key Patterns:
- RPC endpoints extend RpcTarget, use Zod validation
- Return discriminated unions { success: true/false, ... }
- Log with LogTape template literals

From SECURITY.md:
- Rotation must support grace period
- JWKS must serve current + previous keys during rotation

ADR Compliance (via ADR Compliance Agent):
✅ ADR-0001: Will use @catalyst/telemetry for logging
✅ ADR-0002: Will use LogTape
✅ ADR-0004: Keys already in SQLite (ADR satisfied)
✅ ADR-0007: Rotation must preserve cnf claim bindings

Synthesis:
- Add rotateKey() method to AuthRpcServer
- Update KeyManager interface if needed
- Ensure grace period logic for old keys
- Update JWKS endpoint to serve both keys
- Add comprehensive tests

Ready to Implement:
- [x] Scope is clear and focused
- [x] Patterns are understood
- [x] ADRs are satisfied
- [x] No blocking questions

✅ READY TO PROCEED
```
