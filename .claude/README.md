# Claude Code Configuration

This directory contains Claude Code agent definitions, workflows, and configuration for the Catalyst Node project.

## Quick Start - Meet Orbi

**Orbi** is your development orchestrator. Invoke it when you want guided workflow execution with subagents:

```
Orbi I need to fix a PR comment about error handling
orbi add a token refresh endpoint
Orbi how does the peering handshake work?
```

**When to use Orbi vs normal conversation:**

- `Orbi fix the PR comment` → Guided workflow with agents, verification, doc sync
- `what does this error mean?` → Quick answer, no workflow

## Task Types (via Orbi)

```
orbi 🔧 PR Fix: reviewer says token validation should be more specific
orbi ✨ New Feature: add token refresh endpoint
orbi 🔄 Migration: move from InMemoryStore to SqliteStore
orbi 🔍 Exploration: how does the peering handshake work?
orbi 🏗️ Architecture: should we use Cerbos or Cedar?
orbi 📝 Documentation: the rotation flow is confusing
orbi 🧹 Cleanup: remove unused InMemoryCache class
```

## Task Types

| Type              | Emoji | When to Use                    | Pre-Work                  | Verification |
| ----------------- | ----- | ------------------------------ | ------------------------- | ------------ |
| **PR Fix**        | 🔧    | PR comments, reviewer feedback | Stack scope only          | Minimal      |
| **New Feature**   | ✨    | Adding functionality           | Full (scope + docs + ADR) | Full         |
| **Migration**     | 🔄    | Refactoring, moving code       | Impact + ADR              | Full         |
| **Exploration**   | 🔍    | Understanding, research        | None                      | None         |
| **Architecture**  | 🏗️    | Design decisions, trade-offs   | Docs + ADR                | None         |
| **Documentation** | 📝    | Improving docs                 | Doc sync                  | Minimal      |
| **Cleanup**       | 🧹    | Removing cruft                 | Impact analysis           | Full         |

## How It Works

1. **You describe your task** - Natural language, paste PR comments, whatever
2. **Orchestrator identifies type** - Or asks if unclear
3. **Clarifying questions** - Task-specific questions to understand scope
4. **Pre-work runs** - Appropriate agents for context gathering
5. **Guided workflow** - Step-by-step through implementation
6. **Verification** - Appropriate level of testing
7. **Doc sync** - Check if docs need updates

## Directory Structure

```
.claude/
├── README.md                    # This file
├── settings.json                # Configuration and task definitions
└── agents/
    ├── orchestrator.md          # Main entry point
    ├── pre-work.md              # Composite pre-work agent
    ├── stack-scope.md           # Graphite stack analysis
    ├── documentation.md         # Documentation synthesis
    ├── adr-compliance.md        # ADR compliance checking
    ├── verification.md          # Test/lint runner
    ├── cross-package-impact.md  # Dependency analysis
    ├── doc-sync.md              # Documentation update checker
    └── workflows/
        ├── pr-fix.md            # PR comment response workflow
        ├── new-feature.md       # New feature workflow
        ├── migration.md         # Code migration workflow
        ├── exploration.md       # Codebase exploration workflow
        ├── architecture.md      # Architecture decision workflow
        ├── documentation.md     # Documentation improvement workflow
        └── cleanup.md           # Cruft removal workflow
```

## Example Sessions

### PR Fix

```
User: orbi fix a PR comment - reviewer says "error message should be more specific"

Orbi: 🔧 PR Fix Mode
      Which file has this error? Let me check your stack scope...
      [runs stack-scope agent]
      ✅ You're on jt/feat-token-rotation, this fix is in scope.
      [shows specific fix]
      [runs minimal verification]
      Ready to commit!
```

### New Feature

```
User: Orbi add a token refresh endpoint

Orbi: ✨ New Feature Mode
      Let me ask a few questions and run pre-work...
      [runs stack-scope, documentation, adr-compliance in parallel]
      Here's what I found: [patterns, constraints, ADR requirements]
      Ready to plan implementation?
```

### Exploration

```
User: orbi how does the BGP peering handshake work?

Orbi: 🔍 Exploration Mode
      Let me trace through the code...
      [reads docs, traces code]
      Here's how it works: [detailed explanation with code refs]
```

### Normal Conversation (no Orbi)

```
User: what's the difference between access and refresh tokens?

Claude: [Direct answer without workflow orchestration]
        Access tokens are short-lived tokens used for API requests...
```

## Related Documentation

- `../CLAUDE.md` - Main development guide and coding patterns
- `../CLAUDE_AGENTS.md` - Detailed agent documentation with examples
- `../docs/adr/` - Architecture Decision Records
