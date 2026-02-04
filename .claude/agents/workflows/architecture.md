---
name: Architecture Workflow
description: Workflow for design decisions
---

# Architecture Workflow

## Description

Workflow for design decisions, trade-off analysis, and architectural thinking. Focuses on ADRs, documentation, and decision recording before any implementation.

## Clarifying Questions

```
🏗️ Architecture Mode

Let's think through this carefully before coding. Tell me:

1. **What decision are you facing?**
   - Technology choice
   - Pattern selection
   - API design
   - System structure
   - Trade-off evaluation

2. **What's driving this decision?**
   - New requirement
   - Performance concern
   - Scalability need
   - Developer experience
   - Technical debt

3. **What constraints exist?**
   - Existing ADRs to respect
   - Compatibility requirements
   - Resource limitations
   - Timeline pressure

4. **Who are the stakeholders?**
   - Just you
   - Team discussion needed
   - External dependencies
```

## Workflow Steps

### Step 1: Context Gathering

```
📚 Gathering context...

Checking:
- Existing ADRs that might apply
- Related documentation
- Similar decisions made before
- Current system state

This ensures we don't reinvent or contradict existing decisions.
```

### Step 2: Problem Statement

```
Let me make sure I understand the problem:

Problem: [clear statement of what needs deciding]

Context:
- Current state: [how it works now]
- Desired state: [what we want]
- Gap: [what's missing or wrong]

Constraints:
- Must: [non-negotiables]
- Should: [strong preferences]
- Could: [nice to haves]
- Won't: [explicitly out of scope]

Is this accurate?
```

### Step 3: Options Analysis

```
🔍 Analyzing options...

Option A: [Name]
┌─────────────────────────────────────────────────────────────────┐
│ Description: [what this option entails]                        │
├─────────────────────────────────────────────────────────────────┤
│ Pros:                          │ Cons:                         │
│ + [advantage 1]                │ - [disadvantage 1]            │
│ + [advantage 2]                │ - [disadvantage 2]            │
├─────────────────────────────────────────────────────────────────┤
│ Effort: [low/medium/high]      │ Risk: [low/medium/high]       │
│ ADR Compliance: [yes/no/partial]                               │
└─────────────────────────────────────────────────────────────────┘

Option B: [Name]
[same format]

Option C: [Name]
[same format]
```

### Step 4: Recommendation

```
📋 Recommendation

Recommended: Option [X]

Rationale:
1. [Primary reason]
2. [Secondary reason]
3. [Tertiary reason]

Trade-offs accepted:
- [downside we're accepting and why it's okay]

Risks and mitigations:
- Risk: [risk] → Mitigation: [how we handle it]

ADR alignment:
- Supports ADR-XXXX
- Extends ADR-YYYY
- Does not conflict with any existing ADR
```

### Step 5: Decision Recording

```
📝 Recording decision...

Should this become an ADR?

Criteria for ADR:
- [ ] Significant architectural impact
- [ ] Non-obvious decision
- [ ] Future developers need context
- [ ] Reversing would be costly

If yes → Draft ADR using docs/adr/TEMPLATE.md
If no → Document in relevant README or ARCHITECTURE.md
```

### Step 6: ADR Draft (If Needed)

```
# ADR-XXXX: [Title]

## Status
Proposed

## Context
[Problem and context]

## Decision
[What we decided]

## Consequences

### Positive
- [benefit 1]
- [benefit 2]

### Negative
- [trade-off 1]
- [trade-off 2]

### Neutral
- [implication]

## Implementation Notes
[High-level approach]
```

### Step 7: Next Steps

```
✅ Decision recorded

Next steps:
1. [ ] Review ADR with team (if needed)
2. [ ] Get approval
3. [ ] Update CLAUDE.md if patterns change
4. [ ] Plan implementation (switch to Feature/Migration workflow)

When ready to implement, run:
"New Feature: implement [decision]"
or
"Migration: apply [new pattern]"
```

## Example Session

**User:** Should we use Cerbos or Cedar for authorization?

**Orchestrator:**

```
🏗️ Architecture Mode

Important decision! Let me help analyze this.

📚 Context Check:
- ADR-0008 exists but is "Proposed" status
- Currently mentions Cerbos
- Cedar is used in @catalyst/authorization package
- Both are policy-based authorization systems

Let me structure this analysis...

Problem Statement:
We need a policy decision point (PDP) for authorization.
Currently have mixed usage - need to standardize.

Option A: Cerbos
┌─────────────────────────────────────────────────────────────────┐
│ Description: gRPC-based PDP, YAML policies, hosted or embedded │
├─────────────────────────────────────────────────────────────────┤
│ Pros:                          │ Cons:                         │
│ + Rich policy language         │ - Requires running service    │
│ + Good testing tools           │ - Additional infrastructure   │
│ + Active development           │ - Network latency for checks  │
├─────────────────────────────────────────────────────────────────┤
│ Effort: Medium                 │ Risk: Low                     │
│ ADR-0008 alignment: ✅ Yes                                     │
└─────────────────────────────────────────────────────────────────┘

Option B: Cedar (AWS)
┌─────────────────────────────────────────────────────────────────┐
│ Description: WASM-based, embedded evaluation, Cedar language   │
├─────────────────────────────────────────────────────────────────┤
│ Pros:                          │ Cons:                         │
│ + No external service          │ - AWS-centric ecosystem       │
│ + WASM = portable              │ - Less mature tooling         │
│ + Already in codebase          │ - Cedar language learning     │
├─────────────────────────────────────────────────────────────────┤
│ Effort: Low (already present)  │ Risk: Medium                  │
│ ADR-0008 alignment: ❌ Would need amendment                    │
└─────────────────────────────────────────────────────────────────┘

Recommendation: [Would need more context about deployment model,
performance requirements, and team preferences]

Questions to decide:
1. Is external service acceptable, or must it be embedded?
2. How important is the existing Cedar code?
3. What's the policy complexity we expect?

Want me to dive deeper into any aspect?
```

## Architecture Artifacts

This workflow can produce:

1. **ADR** - For significant decisions
2. **RFC** - For proposals needing team input
3. **Spike doc** - For exploratory findings
4. **ARCHITECTURE.md update** - For documenting changes
5. **CLAUDE.md update** - For pattern changes
