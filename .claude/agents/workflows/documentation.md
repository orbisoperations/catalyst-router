---
name: Documentation Workflow
description: Workflow for documentation updates
---

# Documentation Workflow

## Description

Workflow for improving, clarifying, or adding documentation. Minimal code changes - focused on making the codebase more understandable.

## Clarifying Questions

```
📝 Documentation Mode

Let's improve the docs. What do you want to document?

1. **What type of documentation?**
   - [ ] Code comments / JSDoc
   - [ ] Package README
   - [ ] Architecture docs (ARCHITECTURE.md, SECURITY.md)
   - [ ] ADR (new or update)
   - [ ] CLAUDE.md patterns
   - [ ] API documentation
   - [ ] Examples / tutorials

2. **What's the goal?**
   - [ ] Clarify confusing code
   - [ ] Document undocumented feature
   - [ ] Update stale documentation
   - [ ] Add examples
   - [ ] Explain a decision

3. **Specific area?**
   - Package: [which package]
   - Feature: [which feature]
   - File: [which file]
```

## Workflow Steps

### Step 1: Audit Current State

```
📊 Documentation Audit

Checking current documentation for [area]:

Existing docs:
- [doc 1]: [status - current/stale/missing]
- [doc 2]: [status]

Code comments:
- [file]: [well documented / sparse / none]

README:
- [exists/missing] - [current/stale]

Related ADRs:
- [list any that apply]
```

### Step 2: Verify Against Code

```
🔍 Verifying accuracy...

Reading the actual code to ensure docs will be accurate.

Current behavior:
- [what the code actually does]

Documented behavior:
- [what docs say it does]

Gaps:
- [undocumented behavior]
- [incorrect documentation]
- [missing examples]
```

### Step 3: Draft Documentation

````
📝 Drafting documentation...

[Based on documentation type selected]

For Code Comments:
```typescript
/**
 * [Clear description of what this does]
 *
 * @param input - [what this parameter is]
 * @returns [what this returns and when]
 *
 * @example
 * ```typescript
 * const result = myFunction(input)
 * ```
 */
````

For README sections:

````markdown
## [Section Title]

[Clear explanation]

### Usage

```typescript
// Example code
```

### Configuration

| Option | Type | Default | Description |
| ------ | ---- | ------- | ----------- |
| [opt]  | [t]  | [def]   | [desc]      |
````

For ADR updates:

```
[Draft following ADR template]
```

### Step 4: Review for Clarity

```
✅ Documentation Checklist

- [ ] Accurate: Matches current code behavior
- [ ] Clear: No jargon without explanation
- [ ] Complete: Covers main use cases
- [ ] Examples: Includes runnable examples
- [ ] Consistent: Matches project terminology
- [ ] Linked: References related docs
```

### Step 5: Minimal Code Changes (If Needed)

```
If documentation reveals issues:

- Unclear variable names → Propose rename
- Missing types → Add JSDoc types
- Dead code confusing docs → Flag for cleanup

Note: Major code changes should switch to Feature/Migration workflow.
Keep this focused on documentation.
```

### Step 6: Commit

```
Ready to commit documentation changes.

Suggested commit:
docs([scope]): [what was documented]

Examples:
- docs(auth): add JSDoc to token verification functions
- docs: update ARCHITECTURE.md with peering flow
- docs(adr): add ADR-0009 for caching strategy
```

## Example Session

**User:** The token rotation flow is confusing, can we document it better?

**Orchestrator:**

````
📝 Documentation Mode

Let me audit the current token rotation documentation...

📊 Documentation Audit: Token Rotation

Existing docs:
- SECURITY.md: ⚠️ Mentions rotation but sparse details
- packages/auth/README.md: ❌ No rotation section
- jwt.md: ⚠️ Brief mention, no examples
- Code comments: ⚠️ Minimal

🔍 Code Analysis:

Actual rotation flow:
1. Generate new key pair → KeyManager.rotate()
2. Store with new kid → KeyStore.set()
3. Update current kid → KeyManager.setCurrentKeyId()
4. Old key kept for grace period → config.rotation.gracePeriod
5. JWKS serves both keys → getJwks() returns array
6. After grace period → old key pruned

This is underdocumented! Let me draft improvements...

📝 Proposed Documentation:

1. Add to packages/auth/README.md:
```markdown
## Key Rotation

The auth service supports seamless key rotation with zero-downtime.

### How It Works
[diagram and explanation]

### Triggering Rotation
[API examples]

### Grace Period
[explanation of overlap]
```

2. Add to SECURITY.md:

```markdown
## Key Rotation Security

[Security considerations]
```

3. Add JSDoc to packages/auth/src/key-manager.ts:

```typescript
/**
 * Rotates the signing key.
 *
 * Creates a new key pair and sets it as current while keeping
 * the old key available for verification during the grace period.
 *
 * @param gracePeriod - How long to keep old key (default: 24h)
 * @returns The new key ID
 */
```

Want me to apply these documentation improvements?
````

## Documentation Types Reference

| Type         | Location              | When to Use                  |
| ------------ | --------------------- | ---------------------------- |
| JSDoc        | In code               | Function/class documentation |
| README       | packages/\*/README.md | Package overview and usage   |
| Architecture | ARCHITECTURE.md       | System design                |
| Security     | SECURITY.md           | Security-related docs        |
| ADR          | docs/adr/\*.md        | Decision records             |
| CLAUDE.md    | CLAUDE.md             | AI assistant patterns        |
| Inline       | Code comments         | Complex logic explanation    |
