# Stack Remediation Plan (Immutable PRs, Interstitial Insertions)

## Assumptions
- PRs `#353` through `#389` are immutable (no amend/rebase/force-push).
- New PRs can be inserted between existing stack PRs.
- Goal is to keep history coherent: fix closest to the PR that introduced the behavior.

## Insertion Strategy
- Insert follow-up PRs at specific stack boundaries, not only at stack top.
- Keep each inserted PR narrow and reviewable.
- Sequence: blockers first, then correctness/safety, then test/docs hygiene.

## Interstitial Follow-Up PRs

### INS-03a (after `#355`, before `#356`)
**Issues**: `B3`, `H2`, `M1`, `M2`, `L1`, `L2`  
**Scope**
- Extract shared API/propagation types to break circular dependency.
- Remove `@ts-expect-error` by using typed stub accessors/wrappers.
- Add RPC timeout guard in `PeerTransport`.
- Remove dead types and minor type import cleanup.

### INS-06a (after `#358`, before `#359`)
**Issues**: `H1`, `L3`  
**Scope**
- Surface post-commit status/failures (or explicit reconciliation contract) instead of silent fire-and-forget.
- Clean up connection pool construction readability.

### INS-07a (after `#359`, before `#360`)
**Issues**: `B1`, `B2`, `M3`, `M4`, `L6`, `L7`  
**Scope**
- Implement real keepalive transport behavior.
- Fix `holdTime=0` semantics (no expiry / no keepalive scheduling).
- Make tick scheduling dynamic + backpressured.
- Replace `Math.min(...holdTimes)` and ensure lifecycle `stopTick()` is called on shutdown.

### INS-08a (after `#360`, before `#369`)
**Issues**: `M11`  
**Scope**
- Add deterministic best-path tie-breaker in production comparator.
- Strengthen tie-break determinism tests.

### INS-10a (after `#370`, before `#371`)
**Issues**: `H3`, `H4`, `H5`, `H6`, `M5`, `M7`  
**Scope**
- Fix egress port leak on `LocalPeerDelete` and `Tick` expiry.
- Add stale-plan protection in `commit()`.
- Clarify/separate local vs remote port semantics.
- Prevent external mutation via `getState()` contract.
- Make port-allocation failure behavior explicit and tested.

### INS-11a (after `#371`, before `#372`)
**Issues**: `L4`, `L5`  
**Scope**
- Document/deprecate compatibility alias (`ServiceDefinitionSchema`).
- Resolve `L5`: mark stale if not reproducible, or add explicit tie-break docs.

### INS-18a (after `#377`, before `#378`)
**Issues**: `M10`  
**Scope**
- Remove synthetic-plan timing mutation pattern from keepalive/hold-time tests.
- Introduce sanctioned testability path (clock injection or explicit test hook).

### INS-21a (after `#381`, before `#382`)
**Issues**: `M6`, `M8`, `M9`, `L9`  
**Scope**
- Replace fragile timing sleeps in non-container tests with deterministic sync helper.
- Extract shared RIB test helpers.
- Remove conditional assertion anti-pattern.
- Replace widespread `as Plan` casts with narrowing/assert helpers.

### INS-27a (after `#388`, before `#389`)
**Issues**: `L10`  
**Scope**
- Add explicit test for unknown action default branch.

### INS-28a (after `#389`)
**Issues**: `L8`  
**Scope**
- Remove hard-coded test count drift risk (generate count or use non-numeric wording).

## Issue-to-Insertion Mapping

| Issue | Inserted PR |
|---|---|
| B1 | INS-07a |
| B2 | INS-07a |
| B3 | INS-03a |
| H1 | INS-06a |
| H2 | INS-03a |
| H3 | INS-10a |
| H4 | INS-10a |
| H5 | INS-10a |
| H6 | INS-10a |
| M1 | INS-03a |
| M2 | INS-03a |
| M3 | INS-07a |
| M4 | INS-07a |
| M5 | INS-10a |
| M6 | INS-21a |
| M7 | INS-10a |
| M8 | INS-21a |
| M9 | INS-21a |
| M10 | INS-18a |
| M11 | INS-08a |
| L1 | INS-03a |
| L2 | INS-03a |
| L3 | INS-06a |
| L4 | INS-11a |
| L5 | INS-11a |
| L6 | INS-07a |
| L7 | INS-07a |
| L8 | INS-28a |
| L9 | INS-21a |
| L10 | INS-27a |

## Merge Gates
- **Gate A (before `#360`)**: `INS-03a`, `INS-06a`, `INS-07a`
- **Gate B (before `#371`)**: `INS-08a`, `INS-10a`
- **Gate C (before `#382`)**: `INS-11a`, `INS-18a`, `INS-21a`
- **Gate D (end of stack)**: `INS-27a`, `INS-28a`

