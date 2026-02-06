# PR Fix Workflow

## Description

Streamlined workflow for responding to PR comments and reviewer feedback. Optimized for quick, focused fixes within your current stack scope.

## Clarifying Questions

```
📝 PR Fix Mode

I need a few details to help you efficiently:

1. **What's the feedback?**
   - Paste the PR comment or describe the issue

2. **Which file(s) are involved?**
   - Or say "not sure" and I'll help identify

3. **Is this a:**
   - [ ] Code change (logic, bug fix)
   - [ ] Style/formatting issue
   - [ ] Missing test
   - [ ] Documentation gap
   - [ ] Type/interface change
```

## Workflow Steps

### Step 1: Stack Scope (Quick)

```
Run Stack Scope Agent

Verify:
- Am I on the correct branch for this PR?
- Is this fix in scope for this PR?
- Will this change affect PRs above in the stack?
```

### Step 2: Understand the Ask

```
Analyze the PR comment:
- What exactly is being requested?
- Is this a valid concern?
- What's the minimal change to address it?
```

### Step 3: Check Patterns (If Needed)

```
If the fix involves patterns I'm unsure about:
→ Quick Documentation Agent check for the specific pattern
→ Skip full pre-work, just get the relevant info
```

### Step 4: Implement Fix

```
Make the minimal change that addresses the feedback.

Principles:
- Don't scope creep
- Don't refactor unrelated code
- Keep the diff small
- Match existing patterns
```

### Step 5: Verify

```
Run Verification Agent for: [affected package(s)]

For PR fixes, focus on:
1. Type check (quick)
2. Unit tests for affected code
3. Lint check

Skip integration/container tests unless the fix touches RPC/networking.
```

### Step 6: Respond

```
Draft PR comment response:
- Acknowledge the feedback
- Summarize the fix
- Note any follow-up if needed
```

## Example Session

**User:** I need to fix a PR comment. Reviewer says "the error message should be more specific"

**Orchestrator:**

```
📝 PR Fix Mode

Got it - improving an error message. Quick questions:

1. Which file/function has this error message?
2. What does the current message say?
3. What context should the new message include?

While you answer, I'll check your stack scope...

[Runs Stack Scope Agent]

✅ Stack Scope: jt/feat-token-rotation
   This fix is in scope. No PRs above will be affected.
```

**User:** It's in packages/auth/src/jwt.ts, the verifyToken function. Currently says "Invalid token" but should say which validation failed.

**Orchestrator:**

```
Let me check the existing error patterns in that file...

[Quick read of jwt.ts]

I see the pattern - errors use discriminated unions with specific error types.
Current: { success: false, error: 'Invalid token' }
Should be: { success: false, error: 'Token expired' | 'Invalid signature' | etc. }

Here's the fix:

[Shows specific code change]

Should I apply this and run verification?
```

## Output Format

```
PR Fix Summary
==============
Comment: [original feedback]
File: [path]
Change: [one-line description]

Diff:
[minimal diff]

Verification:
✅ Types pass
✅ Tests pass (12 passed, 0 failed)
✅ Lint clean

Ready to commit:
gt modify -m "fix: [description based on feedback]"

Suggested PR response:
> Fixed! The error message now specifies [what]. See [commit].
```
