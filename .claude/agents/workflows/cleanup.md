---
name: Cleanup Workflow
description: Workflow for removing dead code safely
---

# Cleanup Workflow

## Description

Workflow for removing dead code, simplifying abstractions, and eliminating cruft. Emphasizes safe deletion with verification.

## Clarifying Questions

```
🧹 Cleanup Mode

Let's clean things up safely. What are you cleaning?

1. **What type of cleanup?**
   - [ ] Dead code removal
   - [ ] Unused dependencies
   - [ ] Redundant abstractions
   - [ ] Deprecated code removal
   - [ ] Test cleanup
   - [ ] Config simplification

2. **How did you identify this as cruft?**
   - [ ] IDE says unused
   - [ ] No references found
   - [ ] Deprecated and replaced
   - [ ] Never called in tests
   - [ ] Just feels unnecessary

3. **Confidence level?**
   - [ ] Certain it's unused
   - [ ] Pretty sure
   - [ ] Want to verify first
```

## Workflow Steps

### Step 1: Verify It's Actually Unused

```
🔍 Verifying deletion safety...

This is critical - we must be certain before deleting.

Checking:
1. Direct imports/requires
2. Dynamic imports (import(), require())
3. Re-exports from index files
4. String references (reflection, config files)
5. Test coverage (is it tested but not used?)
6. Documentation references

Search patterns:
- Grep for symbol name
- Grep for file name
- Check package.json exports
- Check index.ts re-exports
```

### Step 2: Understand Why It Exists

```
📜 Historical context...

Before deleting, understand why this was created:

- Git blame: Who added it and when?
- Commit message: Why was it added?
- Related PRs: Any context?
- ADRs: Was this part of a decision?

Sometimes "unused" code is:
- Feature flag disabled
- Planned for future use
- Required by external consumer
- Part of public API contract
```

### Step 3: Impact Analysis

```
Run Cross-Package Impact Agent (in deletion mode)

Looking for:
- Would any package break?
- Would any tests fail?
- Would any docs become invalid?
- Would any external consumers break?

Risk assessment:
┌─────────────────────────────────────────────────────────────────┐
│ Deletion: [symbol/file name]                                   │
├─────────────────────────────────────────────────────────────────┤
│ References found: [N]                                          │
│ Test coverage: [yes/no]                                        │
│ Public API: [yes/no]                                           │
│ Documentation refs: [N]                                        │
├─────────────────────────────────────────────────────────────────┤
│ Safe to delete: [YES / NO / NEEDS REVIEW]                      │
└─────────────────────────────────────────────────────────────────┘
```

### Step 4: Staged Deletion

```
For significant deletions, stage the removal:

Stage 1: Deprecate
- Add @deprecated JSDoc tag
- Add console.warn if called
- Update docs to note deprecation

Stage 2: Monitor
- Watch for any runtime warnings
- Check error logs
- Wait appropriate time

Stage 3: Remove
- Delete the code
- Remove from exports
- Update docs

For small/obvious cruft, can go straight to removal.
```

### Step 5: Delete

```
🗑️ Removing cruft...

Deleting:
- [file/symbol 1]
- [file/symbol 2]

Also cleaning up:
- [ ] Imports that referenced deleted code
- [ ] Index re-exports
- [ ] Test files for deleted code
- [ ] Documentation references
```

### Step 6: Verify Nothing Broke

```
Run Verification Agent (full chain)

Critical checks after deletion:
✅ TypeScript compiles (no missing imports)
✅ All tests pass (no missing dependencies)
✅ Lint passes (no unused imports left)
✅ Build succeeds

If anything fails:
→ The code wasn't actually unused
→ Restore and investigate
```

### Step 7: Document Removal

```
Commit message should explain:

chore([package]): remove unused [thing]

[Thing] was added in [commit] for [reason] but is no longer
needed because [explanation].

Verified unused via:
- No imports found
- No test coverage
- [other verification]
```

## Example Session

**User:** There's an old InMemoryCache class that I don't think is used anymore

**Orchestrator:**

```
🧹 Cleanup Mode

Let me verify if InMemoryCache is safe to delete...

🔍 Searching for references...

Direct imports: 0
Re-exports: 0 (not in any index.ts)
String references: 0
Test files: 1 (tests the class itself)
Documentation: 0

📜 Git history:
- Added: 8 months ago by [author]
- Commit: "feat: add caching layer for route lookups"
- Last modified: 6 months ago

🤔 Analysis:
- Class exists and is tested
- But nothing imports or uses it
- Likely replaced by Redis/external caching
- ADR-0004 moved to SQLite, may have obsoleted this

Risk Assessment:
┌─────────────────────────────────────────────────────────────────┐
│ Deletion: InMemoryCache                                        │
├─────────────────────────────────────────────────────────────────┤
│ References found: 0 (excluding its own tests)                  │
│ Test coverage: Yes (but tests are also cruft)                  │
│ Public API: No (not exported from package)                     │
│ Documentation refs: 0                                          │
├─────────────────────────────────────────────────────────────────┤
│ Safe to delete: ✅ YES                                         │
└─────────────────────────────────────────────────────────────────┘

Recommended deletion:
- packages/orchestrator/src/cache/in-memory-cache.ts
- packages/orchestrator/tests/in-memory-cache.test.ts

Should I proceed with deletion and run verification?
```

## Safety Checklist

```
⚠️ Before Deleting, Verify:

- [ ] No direct imports
- [ ] No re-exports from index files
- [ ] No dynamic imports (check for string patterns)
- [ ] No external package consumers
- [ ] Not part of public API
- [ ] Understood why it was created
- [ ] ADRs don't reference it
- [ ] Docs don't reference it

If ANY checkbox fails → Investigate more before deleting
```

## Common Cruft Patterns

| Pattern           | How to Find                | Safe to Delete?         |
| ----------------- | -------------------------- | ----------------------- |
| Unused exports    | IDE warnings               | Yes, if no consumers    |
| Old abstractions  | Grep for imports           | Verify replaced         |
| Commented code    | Search for `//` blocks     | Usually yes             |
| TODO code         | Search for TODO            | Check if still relevant |
| Feature flags     | Search for flags           | Check if deployed       |
| Test utilities    | Used only in deleted tests | Yes                     |
| Type-only exports | Check if types used        | Verify consumers        |
