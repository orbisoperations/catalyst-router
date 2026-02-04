# Exploration Workflow

## Description

Read-only workflow for understanding code, investigating issues, or researching before implementation. No constraints, no verification required - just learning.

## Clarifying Questions

```
🔍 Exploration Mode

I'll help you understand the codebase. What are you exploring?

1. **What's your goal?**
   - [ ] Understand how something works
   - [ ] Find where something is implemented
   - [ ] Investigate a bug or issue
   - [ ] Research before proposing a change
   - [ ] Onboarding / learning the codebase

2. **How deep do you want to go?**
   - [ ] Quick overview (5 min)
   - [ ] Moderate depth (15 min)
   - [ ] Deep dive (30+ min)

3. **Any specific questions?**
   - List what you want to understand
```

## Workflow Steps

### Step 1: Scope the Exploration

```
Based on your goal, I'll explore:

Area: [package/feature/concept]
Starting points: [key files]
Related docs: [relevant documentation]

No changes will be made - this is read-only exploration.
```

### Step 2: Documentation First

```
Let me check what's already documented...

📚 Reading:
- ARCHITECTURE.md sections on [topic]
- Relevant ADRs
- Package READMEs
- Inline code comments

Summary of documented knowledge:
[key points from docs]
```

### Step 3: Code Exploration

```
Now diving into the code...

🔍 Exploring:
- Entry points
- Key functions/classes
- Data flow
- Dependencies

I'll trace through the code and explain what I find.
```

### Step 4: Synthesis

```
📊 Exploration Summary

What I found:
1. [Key insight 1]
2. [Key insight 2]
3. [Key insight 3]

How it works:
[Explanation with code references]

Key files:
- [file 1]: [purpose]
- [file 2]: [purpose]

Patterns used:
- [pattern 1]
- [pattern 2]

Open questions:
- [anything unclear or undocumented]
```

## Exploration Modes

### "How does X work?"

```
Trace the execution flow:
1. Entry point: [where it starts]
2. Key transformations: [what happens to data]
3. Dependencies: [what it relies on]
4. Output: [what it produces]

[Include code snippets with explanations]
```

### "Where is X implemented?"

```
Search results:
- Primary implementation: [file:line]
- Related code: [other files]
- Tests: [test files]
- Usage examples: [where it's used]
```

### "Why does X do Y?"

```
Investigation:
1. Check git blame for context
2. Look for comments explaining the decision
3. Check ADRs for architectural reasons
4. Check related issues/PRs if referenced

Findings:
[explanation of why]
```

### "What would it take to change X?"

```
Impact preview (read-only):
- Files that would change: [list]
- Packages affected: [list]
- Tests that would need updates: [list]
- Docs that reference this: [list]

Complexity estimate: [low/medium/high]
Risks to consider: [list]

Note: This is just analysis. When ready to implement,
switch to the appropriate workflow (Feature/Migration).
```

## Example Session

**User:** How does the token verification flow work?

**Orchestrator:**

````
🔍 Exploration Mode

Great question! Let me trace through token verification.

Starting exploration...

📚 Documentation Check:
- SECURITY.md mentions JWT verification with clock tolerance
- ADR-0007 covers certificate-bound token verification
- packages/auth/README.md documents the VerifyResult type

🔍 Code Trace:

Entry Point:
packages/auth/src/rpc/server.ts:verifyToken()
↓
Core Logic:
packages/auth/src/jwt.ts:verifyToken()

Flow:
1. Parse JWT header (get kid for key lookup)
2. Fetch public key from KeyManager
3. Verify signature using jose library
4. Check standard claims (exp, nbf, iat)
5. If cnf claim present → verify certificate binding
6. Return VerifyResult (discriminated union)

Key Code:
```typescript
// packages/auth/src/jwt.ts
export async function verifyToken(
  token: string,
  keyManager: KeyManager,
  options?: VerifyOptions
): Promise<VerifyResult> {
  // ... [shows relevant code]
}
````

Patterns Used:

- Discriminated union for result (success/failure)
- Clock tolerance of 30 seconds for distributed systems
- Key lookup by kid from JWKS

Related Tests:

- packages/auth/tests/jwt.test.ts
- packages/auth/tests/verify-token.test.ts

Open Questions:

- Revocation checking is optional (controlled by config)
- Certificate binding only checked if cnf claim present

Want me to dive deeper into any part of this?

```

## Output Format

```

🔍 Exploration: [Topic]
═══════════════════════════════════════

Documentation Summary:
[What docs say]

Code Analysis:
[What code does]

Key Files:

- [file]: [purpose]

Patterns:

- [patterns observed]

Insights:

- [key learnings]

Questions Answered:
✅ [question 1]
✅ [question 2]

Remaining Questions:
❓ [anything still unclear]

```

```
