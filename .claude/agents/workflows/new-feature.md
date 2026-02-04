# New Feature Workflow

## Description

Full workflow for implementing new functionality. Includes comprehensive pre-work, guided implementation, verification, and documentation.

## Clarifying Questions

```
✨ New Feature Mode

Let's make sure we build the right thing. Tell me:

1. **What are you building?**
   - Describe the feature in 1-2 sentences

2. **Which package(s) will this touch?**
   - @catalyst/auth, @catalyst/gateway, @catalyst/orchestrator, etc.
   - Or say "not sure" and I'll help identify

3. **Is there an existing ticket/issue?**
   - Link or reference if available

4. **Are there similar features I should reference?**
   - Existing code to use as a pattern

5. **What's the scope?**
   - [ ] New RPC endpoint
   - [ ] New CLI command
   - [ ] Internal logic/utility
   - [ ] Cross-package feature
   - [ ] External API change
```

## Workflow Steps

### Phase 1: Pre-Work (Parallel)

```
┌─────────────────────────────────────────────────────────────────┐
│ Running in parallel...                                          │
│                                                                 │
│ 🔍 Stack Scope Agent                                           │
│    → Is this the right PR for this feature?                    │
│    → Should this be a new stacked PR?                          │
│                                                                 │
│ 📚 Documentation Agent                                          │
│    → What patterns apply?                                       │
│    → What constraints exist?                                    │
│                                                                 │
│ ✅ ADR Compliance Agent                                         │
│    → Which ADRs apply?                                          │
│    → Are we compliant?                                          │
└─────────────────────────────────────────────────────────────────┘
```

### Phase 2: Plan Review

```
Based on pre-work, here's the implementation plan:

Files to create:
- [ ] [list new files]

Files to modify:
- [ ] [list existing files]

Patterns to follow:
- [pattern 1 from docs]
- [pattern 2 from ADRs]

ADR compliance:
- ADR-XXXX: [how we comply]

Estimated scope: [small/medium/large]

Does this look right? Any concerns before we proceed?
```

### Phase 3: Implementation (Guided)

```
Let's build this step by step:

Step 1: [Schema/Types]
→ Define Zod schemas and TypeScript types first
→ This establishes the contract

Step 2: [Core Logic]
→ Implement the main functionality
→ Pure functions where possible

Step 3: [Integration Points]
→ Wire into existing systems (RPC, routes, etc.)

Step 4: [Tests]
→ Unit tests for core logic
→ Integration tests for wiring

I'll guide you through each step. Ready for Step 1?
```

### Phase 4: Cross-Package Impact (If Needed)

```
If touching shared code:
→ Run Cross-Package Impact Agent
→ Identify all affected packages
→ Update each package as needed
```

### Phase 5: Verification (Sequential)

```
Running full verification chain...

1. ✅ Lint
2. ✅ Format
3. ✅ TypeScript
4. 🔄 Unit Tests
5. ⏳ Integration Tests
6. ⏳ Container Tests (if applicable)
```

### Phase 6: Documentation Sync

```
Run Doc Sync Agent

Check:
- Does CLAUDE.md need updates?
- Do package READMEs need updates?
- Should this be documented in ARCHITECTURE.md?
- Any ADR amendments needed?
```

### Phase 7: Commit & Stack

```
Ready to commit!

Suggested commit message:
feat([package]): [description]

[Body explaining what and why]

Commands:
gt add -A
gt modify -m "feat: [description]" # if amending current
# OR
gt create -m "feat: [description]" # if new PR in stack
```

## Example Session

**User:** I want to add a token refresh endpoint

**Orchestrator:**

```
✨ New Feature Mode

Great! A token refresh endpoint. Let me ask a few questions:

1. Should this refresh both access and refresh tokens, or just access?
2. Should it require the old token to be valid, or allow expired tokens?
3. Will this use the existing auth flow or need new logic?

While you think about those, I'm running pre-work...
```

[Pre-work agents run in parallel]

```
Pre-Work Complete
=================

Stack Scope:
✅ Current branch: jt/feat-auth-improvements
✅ This feature fits the PR scope
⚠️ Consider: refresh endpoint is substantial, might warrant own PR

Documentation:
- Follow RpcTarget pattern in packages/auth/src/rpc/server.ts
- Use discriminated unions for response
- Token operations in packages/auth/src/jwt.ts

ADR Compliance:
✅ ADR-0002: Use LogTape for logging
✅ ADR-0007: Must preserve cnf claim in refreshed tokens
⚠️ Consider: Should refreshed token inherit original's certificate binding?

Ready to plan implementation?
```

## Output Checkpoints

At each phase, provide clear status:

```
[Phase 1: Pre-Work] ✅ Complete
[Phase 2: Plan] ⏳ Awaiting approval
[Phase 3: Implementation] ⏳ Not started
[Phase 4: Impact Analysis] ⏳ Not started
[Phase 5: Verification] ⏳ Not started
[Phase 6: Doc Sync] ⏳ Not started
[Phase 7: Commit] ⏳ Not started
```
