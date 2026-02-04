---
name: Migration Workflow
description: Workflow for code migrations
---

# Migration Workflow

## Description

Workflow for code migrations, refactoring across packages, renaming patterns, or updating abstractions. Emphasizes impact analysis and phased implementation.

## Clarifying Questions

```
🔄 Migration Mode

Migrations need careful planning. Help me understand:

1. **What are you migrating?**
   - Pattern/abstraction change
   - Code relocation
   - Dependency update
   - Naming convention change
   - API evolution

2. **What's the scope?**
   - Single package
   - Multiple packages
   - Entire codebase

3. **Is this breaking?**
   - Can old and new coexist temporarily?
   - Do consumers need updates?

4. **What's driving this?**
   - ADR decision
   - Tech debt reduction
   - Performance improvement
   - API consistency
```

## Workflow Steps

### Phase 1: Impact Analysis (CRITICAL)

```
🔍 Running Cross-Package Impact Agent...

This is the most important step for migrations.

Analyzing:
- All usages of [old pattern/code]
- Direct dependents
- Transitive dependents
- Test coverage of affected areas
- Documentation references

Output:
┌─────────────────────────────────────────────────────────────────┐
│ Impact Analysis                                                 │
├─────────────────────────────────────────────────────────────────┤
│ Files affected: 23                                             │
│ Packages affected: 5                                           │
│ Tests to update: 12                                            │
│ Docs to update: 3                                              │
├─────────────────────────────────────────────────────────────────┤
│ Risk: MEDIUM                                                   │
│ Recommendation: Phase into 3 PRs                               │
└─────────────────────────────────────────────────────────────────┘
```

### Phase 2: ADR Check

```
Run ADR Compliance Agent

Questions:
- Is this migration required by an ADR?
- Does this migration require a new ADR?
- Does this change any existing ADR decisions?

If new pattern emerges → Draft ADR first
```

### Phase 3: Migration Plan

```
Based on impact analysis, here's the phased plan:

Phase A: Foundation (PR 1)
- Create new abstraction/pattern
- Don't remove old yet
- Add migration helper if needed

Phase B: Migrate (PR 2-N)
- Update consumers package by package
- Each package = potentially separate PR
- Maintain backwards compatibility

Phase C: Cleanup (Final PR)
- Remove old abstraction
- Remove migration helpers
- Update documentation

Estimated PRs: [N]
Order of packages: [based on dependency graph]

Should we proceed with this plan?
```

### Phase 4: Phased Implementation

For each phase:

```
📦 Phase [X]: [Package Name]

Step 1: Create branch
gt create -m "[type]: migrate [package] to [new pattern]"

Step 2: Update code
[Specific changes for this package]

Step 3: Update tests
[Test changes needed]

Step 4: Verify
Run Verification Agent for: @catalyst/[package]

Step 5: Check coexistence
- Old code still works? ✅
- New code works? ✅
- No circular dependencies? ✅

Ready for next phase?
```

### Phase 5: Per-Phase Verification

```
After each phase:

✅ Lint passes
✅ Types pass
✅ Tests pass
✅ Old pattern still works (if not final phase)
✅ New pattern works
✅ No regressions in dependent packages
```

### Phase 6: Final Cleanup

```
🧹 Final Cleanup Phase

Now that all consumers are migrated:

1. Remove old abstraction
2. Remove any temporary compatibility layers
3. Remove old tests
4. Update CLAUDE.md with new pattern
5. Update/create ADR if needed

Run full verification chain across all affected packages.
```

## Example Session

**User:** I need to migrate from InMemoryStore to SqliteStore across all packages

**Orchestrator:**

```
🔄 Migration Mode

Got it - migrating storage backends. This is exactly what ADR-0004 requires.

Let me run impact analysis...

[Cross-Package Impact Agent runs]

Impact Analysis Complete
========================
Pattern: InMemoryStore → SqliteStore

Affected Packages:
1. @catalyst/auth (UserStore, TokenStore, RevocationStore)
2. @catalyst/orchestrator (RouteStore, PeerStore)
3. @catalyst/cli (ConfigStore)

Files to modify: 18
Tests to update: 24
ADR reference: ADR-0004 ✅

Recommended Approach:
Since SqliteStore interface matches InMemoryStore, we can:
1. Keep both implementations
2. Switch via configuration
3. Migrate package by package
4. Remove InMemory after full migration

Phase Plan:
┌────────┬─────────────────────────┬───────────────┐
│ PR     │ Scope                   │ Risk          │
├────────┼─────────────────────────┼───────────────┤
│ 1      │ Add SqliteStore impls   │ Low (additive)│
│ 2      │ Migrate @catalyst/auth  │ Medium        │
│ 3      │ Migrate @catalyst/orch  │ Medium        │
│ 4      │ Migrate @catalyst/cli   │ Low           │
│ 5      │ Remove InMemoryStore    │ Low (cleanup) │
└────────┴─────────────────────────┴───────────────┘

Start with PR 1?
```

## Safety Checks

Throughout migration:

```
⚠️ Migration Safety Checklist

Before each commit:
- [ ] Old code path still works
- [ ] New code path works
- [ ] No mixed state issues
- [ ] Tests cover both paths
- [ ] Can rollback if needed

Before final cleanup:
- [ ] All consumers migrated
- [ ] No remaining usages of old pattern
- [ ] Documentation updated
- [ ] ADR reflects final state
```
