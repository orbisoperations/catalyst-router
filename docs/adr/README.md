# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for the catalyst-router project.

## What is an ADR?

An ADR is a document that captures an important architectural decision made along with its context and consequences. ADRs help us:

- **Remember** why decisions were made
- **Onboard** new team members with historical context
- **Revisit** decisions when circumstances change
- **Avoid** relitigating settled debates

## ADR Index

| ADR                                                   | Title                                        | Status     | Date       |
| ----------------------------------------------------- | -------------------------------------------- | ---------- | ---------- |
| [0001](./0001-unified-opentelemetry-observability.md) | Unified OpenTelemetry Observability          | Accepted   | 2026-01-26 |
| [0002](./0002-logging-library-selection.md)           | Logging Library Selection (LogTape vs Pino)  | Accepted   | 2026-01-26 |
| [0003](./0003-observability-backends.md)              | Observability Backend Selection              | Proposed   | 2026-01-26 |
| [0004](./0004-sqlite-storage-backend.md)              | SQLite as Unified Storage Backend            | Superseded | 2026-01-26 |
| [0005](./0005-docker-as-container-runtime.md)         | Docker as Container Runtime                  | Accepted   | 2026-01-27 |
| [0006](./0006-node-orchestrator-architecture.md)      | Node Orchestrator Architecture               | Accepted   | 2026-01-29 |
| [0007](./0007-certificate-bound-access-tokens.md)     | Certificate Bound Access Tokens for BGP      | Proposed   |            |
| [0008](./0008-permission-policy-schema.md)            | Permission Policy Schema                     | Proposed   | 2026-01-30 |
| [0009](./0009-relational-database-style-guide.md)     | Relational Database Style Guide              | Accepted   |            |
| [0010](./0010-catalyst-service-base-class.md)         | Unified Service Base Class (CatalystService) | Accepted   | 2026-02-09 |
| [0011](./0011-adopt-nodejs-runtime.md)                | Adopt Node.js as JavaScript Runtime          | Accepted   | 2026-02-19 |
| [0012](./0012-sqlite-on-nodejs.md)                    | SQLite Storage Backend on Node.js            | Accepted   | 2026-02-18 |
| [0013](./0013-test-runner-selection.md)               | Test Runner Selection (Vitest)               | Accepted   | 2026-02-18 |
| [0014](./0014-package-manager-selection.md)           | Package Manager Selection (pnpm)             | Accepted   | 2026-02-18 |

## Statuses

| Status         | Meaning                               |
| -------------- | ------------------------------------- |
| **Proposed**   | Under discussion, not yet accepted    |
| **Accepted**   | Approved and ready for implementation |
| **Deprecated** | No longer relevant or recommended     |
| **Superseded** | Replaced by a newer ADR               |

## Creating a New ADR

1. Copy [TEMPLATE.md](./TEMPLATE.md) to a new file
2. Name it `XXXX-short-title.md` (use next available number)
3. Fill in all sections
4. Submit for review
5. Update this README's index

### Naming Convention

```
NNNN-kebab-case-title.md

Examples:
0001-unified-opentelemetry-observability.md
0002-logging-library-selection.md
0003-database-migration-strategy.md
```

## Guidelines

### When to Write an ADR

Write an ADR when:

- Choosing between multiple valid technical approaches
- Making decisions that are costly to reverse
- Establishing patterns that will be followed project-wide
- Deprecating or replacing existing approaches

### When NOT to Write an ADR

Skip the ADR when:

- The decision is easily reversible
- It's a standard library/framework choice with no alternatives
- It only affects a single file or component

### Good ADR Practices

1. **Decision first** — ADRs are decision-first documents. Put the conclusion before the analysis so readers immediately see what was decided
2. **Be specific** — Include concrete examples, not just abstract descriptions
3. **Show alternatives** — Document at least 2-3 options considered (in the Appendix)
4. **Explain trade-offs** — Every decision has downsides; acknowledge them upfront
5. **Link context** — Reference issues, discussions, or other ADRs
6. **Keep it current** — Update status when decisions change

### Document Structure

ADRs follow this order:

```
Header → Context (brief) → Decision → Consequences → Implementation → Appendix: Options Considered
```

The **Decision** section comes early so readers can quickly understand what was chosen. Detailed options analysis goes in a collapsible **Appendix** at the end for those who want to understand the full evaluation.

## References

- [Michael Nygard's ADR article](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
- [ADR GitHub organization](https://adr.github.io/)
