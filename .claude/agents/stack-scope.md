---
name: Stack Scope
description: Understand stack boundaries
---

# Stack Scope Agent

## Description

Understand the current Graphite stack before making changes. Determines what's in scope for the current PR to keep changes focused and avoid scope creep.

## Agent Type

Explore

## When to Use

- At the start of any implementation task
- Before deciding what files to modify
- When reviewing someone else's stack

## Prompt

```
Analyze the current Graphite stack scope for this repository.

Run these commands to understand the stack:
- `gt log short` - View stack structure
- `gt stack` - See all branches in stack
- `git diff --name-only $(gt trunk)...HEAD` - Files changed in this stack

Determine:
1. What branch am I currently on?
2. What PRs are in my current stack (below and above)?
3. What is the intent/theme of the current PR based on its name?
4. What files have been modified in this specific PR (not the whole stack)?

Report:
- Stack structure visualization
- Current PR scope boundaries
- What changes would be IN scope vs OUT of scope
- Recommendation: Should work be split into additional stacked PRs?
```

## Example Usage

**Prompt:**

```
Run the Stack Scope Agent before I start implementing token rotation.
```

**Expected Output:**

```
Current Branch: jt/feat-add-token-rotation
Stack Position: 2 of 3

Stack Structure:
  ┌─ jt/feat-add-revocation-ui (above)
  ├─ jt/feat-add-token-rotation (current) ← YOU ARE HERE
  └─ jt/refactor-auth-stores (below, merged to main)

Files Modified in Current PR:
- packages/auth/src/token-manager.ts
- packages/auth/src/rpc/schema.ts
- packages/auth/tests/rotation.test.ts

In Scope: Token rotation logic, rotation RPC endpoint, rotation tests
Out of Scope: UI changes (PR above), store refactoring (PR below)

Recommendation: Keep changes focused on rotation mechanism.
```
