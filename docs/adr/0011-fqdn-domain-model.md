# ADR-0011: Structured FQDN Domain Model

**Status:** Proposed
**Date:** 2026-02-12
**Decision Owner(s):** Engineering Team

## Context

The Catalyst Router uses domain names to identify nodes, scope trust boundaries, and construct service routing prefixes. The current domain model treats domains as an unstructured array of strings with no enforced relationship between a node's identity and its organization's domain.

### Current State

- **`NodeConfigSchema.domains`** is `z.array(z.string())` -- an opaque list with no defined semantics for how entries relate to each other or to the node's identity.
- **`CATALYST_NODE_ID`** is expected to be an FQDN (e.g., `node-a.somebiz.local.io`), but the relationship between this value and the `CATALYST_DOMAINS` list is validated only by a hardcoded check against `.somebiz.local.io` in the orchestrator (`orchestrator.ts:178`).
- **`CATALYST_DOMAINS`** is a comma-separated list of domains the node manages, but there is no structure enforcing that a node belongs to exactly one organizational domain.
- **Hardcoded validation**: `validateNodeConfig()` checks `name.endsWith('.somebiz.local.io')`, blocking any custom domain usage.
- **Cedar authorization**: `trustedDomains` is a `Set<String>` in the policy entity, requiring set containment checks. The auth service extracts the first domain with `this.config.node.domains[0] || ''` as a fallback pattern, revealing that the "array" model is already treated as a single value in practice.
- **Data channel FQDNs**: No formal specification exists for how data channel names compose with the node and organization domain to form a routable FQDN.

### Requirements

| Requirement                                      | Priority | Notes                                                         |
| ------------------------------------------------ | -------- | ------------------------------------------------------------- |
| Structured FQDN derivation from config           | Must     | Node FQDN must be deterministically derived from config       |
| Support custom organizational domains            | Must     | Remove hardcoded `.somebiz.local.io` dependency               |
| Single organizational domain per node            | Must     | Simplifies trust model and DNS delegation                     |
| Data channel FQDN construction                   | Must     | Channels need routable FQDNs for Envoy listener domains       |
| Backward-compatible environment variable mapping | Should   | Minimize disruption to existing docker-compose configurations |
| Simplified Cedar authorization                   | Should   | Single string comparison instead of set containment           |

## Decision

**Chosen Option: Single organizational domain with derived FQDNs**

Replace the `domains: string[]` array in `NodeConfigSchema` with a single `domain: string` field. Node FQDNs and data channel FQDNs are derived by convention:

- **Node FQDN**: `{nodeId}.{orgDomain}` (e.g., `node-a.example.local`)
- **Data channel FQDN**: `{channel}.{nodeId}.{orgDomain}` (e.g., `books.node-a.example.local`)

The `CATALYST_NODE_ID` environment variable becomes a short label (e.g., `node-a`) rather than a full FQDN. A new `CATALYST_ORG_DOMAIN` environment variable replaces `CATALYST_DOMAINS`. At config load time, `loadDefaultConfig()` constructs the full FQDN as `node.name = ${CATALYST_NODE_ID}.${CATALYST_ORG_DOMAIN}`, so downstream code can use `config.node.name` as the complete FQDN without manual assembly.

### Rationale

1. **Eliminates ambiguity** -- A single `domain` field removes the question of which domain in the array is "the" domain. The current code already treats it as a single value (`domains[0]`).
2. **Enables custom domains** -- Removing the hardcoded `.somebiz.local.io` check allows any valid domain, while the structured `{nodeId}.{orgDomain}` format preserves DNS hierarchy and wildcard certificate compatibility.
3. **Simplifies authorization** -- The `NodeContextSchema` uses a single `domain: string` instead of `domains: string[]`, and the Cedar `AdminPanel` entity receives `domainId` as a single string rather than extracting `domains[0]`.
4. **Formalizes FQDN construction** -- Data channel routing through Envoy requires deterministic FQDNs. The `{channel}.{nodeId}.{orgDomain}` convention provides this without additional configuration per channel.

### Trade-offs Accepted

- **Single domain per node** -- A node can no longer claim membership in multiple domains simultaneously. This is acceptable because multi-domain nodes were never meaningfully used; the array was always treated as a single value in practice.
- **Environment variable rename** -- `CATALYST_DOMAINS` becomes `CATALYST_ORG_DOMAIN`, requiring updates to all docker-compose files and deployment configurations. This is a one-time migration cost.
- **Node ID semantic change** -- `CATALYST_NODE_ID` shifts from "full FQDN" to "short label". The full FQDN is now derived as `{nodeId}.{orgDomain}`. Existing configurations that use FQDNs as node IDs (e.g., `node-a.somebiz.local.io`) must be updated to the short form (e.g., `node-a`).

## Consequences

### Positive

- Deterministic FQDN construction at config load time -- `config.node.name` is the complete FQDN, no manual assembly required.
- Wildcard TLS certificates (`*.example.local`) naturally cover all node FQDNs under a given org domain.
- Data channel FQDNs (`{channel}.{nodeId}.{orgDomain}`) enable DNS-based routing and Envoy SNI matching.
- Authorization simplification: `NodeContextSchema` uses `domain: string` instead of `domains: string[]`, and Cedar entity attributes use `domainId` as a single string.
- Custom domain support unlocked without code changes -- any valid domain works.

### Negative

- Breaking change to `NodeConfigSchema` -- all consumers of `config.node.domains` must migrate to `config.node.domain`.
- Docker-compose files and test fixtures need updating for the new environment variable names.

### Neutral

- The BGP protocol layer is unaffected -- route prefixes already use arbitrary strings. The FQDN format is a convention enforced at the config/identity layer, not the protocol layer.

## Implementation

### Config schema change

```typescript
// Before
export const NodeConfigSchema = z.object({
  name: z.string(),
  domains: z.array(z.string()),
  endpoint: z.string().optional(),
  // ...
})

// After
export const NodeConfigSchema = z.object({
  name: z.string(), // Full FQDN, constructed at load time (e.g., "node-a.example.local")
  domain: z.string(), // Organization domain (e.g., "example.local")
  endpoint: z.string().optional(),
  // ...
})
```

### Environment variable mapping

| Before             | After                 | Example Value            |
| ------------------ | --------------------- | ------------------------ |
| `CATALYST_NODE_ID` | `CATALYST_NODE_ID`    | `node-a` (was full FQDN) |
| `CATALYST_DOMAINS` | `CATALYST_ORG_DOMAIN` | `example.local`          |

### FQDN derivation

FQDN construction happens at config load time in `loadDefaultConfig()`. Downstream code uses `config.node.name` as the complete FQDN:

```typescript
// In loadDefaultConfig():
node: {
  name: orgDomain ? `${nodeName}.${orgDomain}` : nodeName,
  domain: orgDomain,
  // ...
}

// Downstream usage -- config.node.name is already the full FQDN
this.telemetry.logger.info`Orchestrator running as ${this.config.node.name}`

// Data channel FQDN construction
const channelFqdn = `${channelName}.${config.node.name}`  // e.g., "books.node-a.example.local"
```

### Authorization schema change

```typescript
// Before
export const NodeContextSchema = z.object({
  nodeId: z.string(),
  domains: z.array(z.string()),
})

// After
export const NodeContextSchema = z.object({
  nodeId: z.string(),
  domain: z.string(),
})
```

The Cedar `AdminPanel` entity now receives `domainId` as a single string:

```typescript
builder.entity('CATALYST::AdminPanel', 'admin-panel').setAttributes({
  nodeId: request.nodeContext.nodeId,
  domainId: request.nodeContext.domain, // was: request.nodeContext.domains[0]
})
```

### Validation change

```typescript
// Before -- hardcoded domain
private validateNodeConfig() {
  if (!name.endsWith('.somebiz.local.io')) {
    throw new Error(`Invalid node name: ${name}. Must end with .somebiz.local.io`)
  }
}

// After -- configurable domain validation
private validateNodeConfig() {
  const { name, domain } = this.config.node
  if (domain && !name.endsWith(`.${domain}`)) {
    throw new Error(
      `Node name ${name} does not match configured domain: ${domain}. ` +
      `Expected format: {nodeId}.${domain}`
    )
  }
}
```

### Migration path

1. Update `NodeConfigSchema` in `@catalyst/config`: `domains: string[]` to `domain: string`
2. Update `loadDefaultConfig()` to read `CATALYST_ORG_DOMAIN` and construct FQDN as `node.name`
3. Update all consumers of `config.node.domains` to use `config.node.domain`
4. Replace hardcoded `.somebiz.local.io` check with configurable domain validation
5. Update `NodeContextSchema` from `domains: z.array(z.string())` to `domain: z.string()`
6. Update docker-compose files and test fixtures

## Risks and Mitigations

| Risk                                          | Likelihood | Impact | Mitigation                                                                                                 |
| --------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------- |
| Missed consumer of `config.node.domains`      | Medium     | Medium | TypeScript compiler flags all type errors after schema change                                              |
| Multi-domain requirement emerges later        | Low        | Medium | Can extend `domain` to `domains: string[]` if needed; single-domain is sufficient for current architecture |
| DNS delegation complexity with custom domains | Low        | Low    | Documentation will cover wildcard DNS and certificate setup                                                |

## Related Decisions

- [ADR-0007](./0007-certificate-bound-access-tokens.md) - Certificate-bound tokens use the node FQDN as the certificate subject
- [ADR-0008](./0008-permission-policy-schema.md) - Cedar policy schema references domain attributes on node entities

## References

- `packages/config/src/index.ts` -- `NodeConfigSchema` and `loadDefaultConfig()`
- `apps/orchestrator/src/orchestrator.ts` -- `validateNodeConfig()` with configurable domain validation
- `packages/authorization/src/service/service.ts` -- `config.node.domain` usage
- `packages/authorization/src/service/rpc/schema.ts` -- `NodeContextSchema` with `domain: z.string()`

---

## Appendix: Options Considered

<details>
<summary>Click to expand full options analysis</summary>

### Option 1: Single organizational domain with derived FQDNs (chosen)

Replace `domains: string[]` with `domain: string`. FQDN is constructed at config load time: `node.name = ${nodeId}.${orgDomain}`. Data channel FQDNs are derived by convention: `{channel}.{node.name}`.

**Approach:**

- Single `domain` field in config schema
- `CATALYST_NODE_ID` becomes a short label
- New `CATALYST_ORG_DOMAIN` environment variable
- FQDN constructed at config load time in `loadDefaultConfig()`

**Pros:**

- Simple, deterministic FQDN construction
- Matches how the code already uses `domains[0]`
- Simplifies Cedar authorization to string equality
- Supports wildcard TLS certificates naturally

**Cons:**

- Breaking change to schema and env vars
- Limits nodes to a single domain (acceptable for current needs)

### Option 2: Keep domains array, add primary domain field

Add an `orgDomain` field alongside the existing `domains` array, keeping backward compatibility.

**Approach:**

- Add `orgDomain: z.string()` to `NodeConfigSchema`
- Keep `domains: z.array(z.string())` for backward compatibility
- Use `orgDomain` for FQDN construction, `domains` for legacy trust checks

**Pros:**

- No breaking change to existing consumers
- Gradual migration path

**Cons:**

- Two sources of truth for domain identity
- `domains` array remains unused but present, causing confusion
- Cedar policies must support both `orgDomain` and `trustedDomains`
- Does not solve the structural ambiguity problem

### Option 3: Structured domain object

Replace the string array with a typed domain object containing org, zone, and node components.

**Approach:**

- `domain: { org: string, zone?: string, node: string }`
- FQDN constructed from components: `{node}.{zone}.{org}` or `{node}.{org}`
- More complex schema with explicit hierarchy

**Pros:**

- Maximum structure and type safety
- Supports multi-level DNS hierarchies (e.g., `node-a.us-east.example.com`)

**Cons:**

- Over-engineered for current needs (no multi-zone deployment exists)
- More complex environment variable mapping
- Harder to express as a simple env var (would need multiple variables or JSON)

</details>
