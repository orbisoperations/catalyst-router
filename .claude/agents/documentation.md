# Documentation Agent

## Description

Read and synthesize relevant documentation before implementation. Ensures changes reinforce (or deliberately update) existing patterns.

## Agent Type

Explore

## When to Use

- Before any implementation work
- When touching unfamiliar parts of the codebase
- When the task involves architecture or security

## Prompt

```
Read the documentation relevant to: [TASK_DESCRIPTION]

Check these docs based on the task area:
- ARCHITECTURE.md - System design, component interactions, plugin architecture
- SECURITY.md - Auth, crypto, peering, tokens, mTLS
- BGP_PROTOCOL.md - Peering, routing, propagation, BGP messages
- TECH_STACK.md - Library choices, framework patterns
- INTERNAL_PEERING.md - iBGP specifications, mesh topology
- packages/[relevant]/README.md - Package-specific context

For each relevant doc, extract:
1. Key patterns or requirements that apply to this task
2. Constraints or "don't do this" guidance
3. Terminology to use consistently
4. Open questions or TODOs that might affect this work

Also check:
- CLAUDE.md for coding patterns and conventions
- Related test files for expected behavior patterns

Summarize:
- What I need to know before implementing
- Patterns I must follow
- Constraints I must respect
- Terminology to use
```

## Example Usage

**Prompt:**

```
Run the Documentation Agent for adding a new RPC endpoint for key rotation.
Focus on SECURITY.md, ARCHITECTURE.md, and packages/auth/README.md.
```

**Expected Output:**

```
Relevant Documentation Summary for: Key Rotation RPC Endpoint

From SECURITY.md:
- Key rotation must support grace period for in-flight tokens
- New keys must be generated before old keys expire
- JWKS endpoint must serve both current and previous keys during rotation
- Rotation events must be logged for audit

From ARCHITECTURE.md:
- RPC endpoints extend RpcTarget from capnweb
- Public methods become RPC endpoints automatically
- Use Zod for input validation, discriminated unions for responses

From packages/auth/README.md:
- KeyManager interface defines rotation contract
- PersistentLocalKeyManager handles SQLite-backed keys
- See existing rotateKey() stub for intended signature

Patterns to Follow:
- Validate input with Zod schema
- Return { success: true, ... } | { success: false, error: string }
- Log with LogTape: logger.info`Key rotated ${keyId}`

Constraints:
- Cannot delete keys immediately (grace period required)
- Must update JWKS endpoint atomically
```
