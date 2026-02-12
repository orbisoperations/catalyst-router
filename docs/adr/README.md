# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for the catalyst-router project.

## What is an ADR?

An ADR is a document that captures an important architectural decision made along with its context and consequences. ADRs help us:

- **Remember** why decisions were made
- **Onboard** new team members with historical context
- **Revisit** decisions when circumstances change
- **Avoid** relitigating settled debates

## ADR Index

| ADR                                                | Title                                        | Status   | Date       |
| -------------------------------------------------- | -------------------------------------------- | -------- | ---------- |
| [[0001-unified-opentelemetry-observability\|0001]] | Unified OpenTelemetry Observability          | Accepted | 2026-01-26 |
| [[0002-logging-library-selection\|0002]]           | Logging Library Selection (LogTape vs Pino)  | Accepted | 2026-01-26 |
| [[0003-observability-backends\|0003]]              | Observability Backend Selection              | Proposed | 2026-01-26 |
| [[0004-sqlite-storage-backend\|0004]]              | SQLite as Unified Storage Backend            | Accepted | 2026-01-26 |
| [[0005-docker-as-container-runtime\|0005]]         | Docker as Container Runtime                  | Accepted | 2026-01-27 |
| [[0006-node-orchestrator-architecture\|0006]]      | Node Orchestrator Architecture               | Accepted | 2026-01-29 |
| [[0007-certificate-bound-access-tokens\|0007]]     | Certificate Bound Access Tokens for BGP      | Proposed |            |
| [[0008-permission-policy-schema\|0008]]            | Permission Policy Schema                     | Proposed | 2026-01-30 |
| [[0009-relational-database-style-guide\|0009]]     | Relational Database Style Guide              | Accepted |            |
| [[0010-catalyst-service-base-class\|0010]]         | Unified Service Base Class (CatalystService) | Accepted | 2026-02-09 |

## Statuses

| Status         | Meaning                               |
| -------------- | ------------------------------------- |
| **Proposed**   | Under discussion, not yet accepted    |
| **Accepted**   | Approved and ready for implementation |
| **Deprecated** | No longer relevant or recommended     |
| **Superseded** | Replaced by a newer ADR               |

## Creating a New ADR

1. Copy [[TEMPLATE|TEMPLATE.md]] to a new file
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
