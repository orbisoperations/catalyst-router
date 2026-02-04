---
name: ADR Compliance
description: Check Architecture Decision Record compliance
---

# ADR Compliance Agent

## Description

Ensure implementation follows Architecture Decision Records. Identifies relevant ADRs, checks compliance, and recommends changes if deviating.

## Agent Type

Explore

## When to Use

- Before any implementation (part of pre-work phase)
- When touching areas covered by ADRs (observability, storage, auth)
- When proposing a new technical approach

## Prompt

```
Check ADR compliance for: [TASK_DESCRIPTION]

Read all ADRs in docs/adr/ and analyze:

ADR Reference:
- ADR-0001: Unified OpenTelemetry Observability
- ADR-0002: Logging Library Selection (LogTape)
- ADR-0003: Observability Backends (Prometheus, Jaeger, InfluxDB)
- ADR-0004: SQLite Storage Backend
- ADR-0007: Certificate-Bound Access Tokens
- ADR-0008: Permission Policy Schema (Cerbos)

For each potentially relevant ADR:
1. Is this ADR applicable to the task?
2. What specific requirements does it impose?
3. Does the planned approach comply?
4. If non-compliant, what needs to change?

Report Format:
✅ Compliant: [ADR] - [how we comply]
❌ Non-Compliant: [ADR] - [issue and required fix]
⚠️ Partially Compliant: [ADR] - [what's missing]
N/A: [ADR] - [why not applicable]

If non-compliant, provide:
- Specific code changes needed to comply
- OR rationale for proposing an ADR amendment
```

## Example Usage

**Prompt:**

```
Check ADR compliance for adding user activity logging to the auth service.
I plan to use console.log for debugging and store logs in a JSON file.
```

**Expected Output:**

````
ADR Compliance Check: User Activity Logging

❌ Non-Compliant: ADR-0002 (Logging Library Selection)
   Issue: Using console.log instead of LogTape
   Required: Use LogTape with template literals
   Fix:
   ```typescript
   import { getLogger } from '@catalyst/telemetry'
   const logger = getLogger(['auth', 'activity'])
   logger.info`User ${userId} performed ${action}`
   ```

❌ Non-Compliant: ADR-0004 (SQLite Storage Backend)
   Issue: Storing logs in JSON file instead of SQLite
   Required: All persistent state must use SQLite via bun:sqlite
   Fix: Create ActivityLogStore implementing the Store interface
   with SqliteStore backend

✅ Compliant: ADR-0001 (OpenTelemetry)
   Using @catalyst/telemetry satisfies OTEL requirements

N/A: ADR-0007 (Certificate-Bound Tokens)
   Activity logging doesn't involve JWT tokens

N/A: ADR-0008 (Permission Policy Schema)
   Activity logging doesn't require authorization checks

Recommendation: Refactor to use LogTape + SQLite. No ADR amendments needed.
````
