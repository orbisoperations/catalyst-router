---
name: Doc Sync
description: Check if documentation needs updates
---

# Doc Sync Agent

## Description

Check if documentation needs updates after implementation. Ensures docs stay current with code changes and identifies when ADRs need amendments.

## Agent Type

Explore

## When to Use

- After completing implementation
- Before finalizing a PR
- When adding new features or changing behavior

## Prompt

```
Check if documentation needs updates after: [CHANGES_MADE]

Files modified: [LIST_OF_FILES]

Review each documentation source:

1. CLAUDE.md
   - Do any code patterns need updating?
   - Are there new environment variables?
   - Should new patterns be added to AI Guidelines?

2. ADRs (docs/adr/)
   - Did we deviate from any ADR?
   - Should an ADR be amended?
   - Should a new ADR be created?

3. ARCHITECTURE.md
   - Did system design change?
   - Are component interactions different?
   - Do diagrams need updating?

4. SECURITY.md
   - Did auth/crypto behavior change?
   - Are there new security considerations?

5. Package READMEs
   - Did the package's public API change?
   - Are usage examples still accurate?

6. Inline Code Comments
   - Are any comments now stale?
   - Should new complex logic be documented?

Report:
- Updates Required: [doc -> specific changes needed]
- ADR Status: [compliant / needs amendment / new ADR needed]
- CLAUDE.md Changes: [specific additions/modifications]
- No Changes Needed: [docs that are still accurate]

For each update, provide:
- The specific section to modify
- Draft of the new/changed content
```

## Example Usage

**Prompt:**

```
Check if documentation needs updates after adding certificate-bound token support.

Changes made:
- Added cnf claim to JWT generation in packages/auth/src/jwt.ts
- Added certificate thumbprint verification in token validation
- Added new RPC endpoint: bindCertificate()
- Updated AuthRpcServer with new method
```

**Expected Output:**

````
Documentation Sync Check
========================

Changes Analyzed:
- packages/auth/src/jwt.ts (cnf claim generation)
- packages/auth/src/rpc/server.ts (bindCertificate endpoint)
- packages/auth/tests/certificate-binding.test.ts (new tests)

Updates Required:

1. CLAUDE.md - JWT Operations section
   Current:
   ```
   // Reserved claims (iss, sub, aud, exp, nbf, iat, jti) cannot be overridden
   ```
   Add:
   ```
   // Certificate-bound tokens include cnf claim with x5t#S256 thumbprint
   // See ADR-0007 for certificate binding requirements
   ```

2. packages/auth/README.md - API section
   Add new endpoint documentation:
   ```markdown
   ### bindCertificate(request)
   Binds a client certificate to an existing token for mTLS verification.

   Request: { token: string, certificatePem: string }
   Response: { success: true, boundToken: string } | { success: false, error: string }
   ```

3. SECURITY.md - Token Security section
   Add paragraph about certificate binding:
   ```markdown
   ## Certificate-Bound Tokens

   For BGP peering sessions, tokens are bound to client certificates per RFC 8705.
   The JWT includes a `cnf` claim containing the SHA-256 thumbprint of the
   client certificate. During mTLS handshake, the server verifies the
   presented certificate matches the token's thumbprint.
   ```

ADR Status:
✅ ADR-0007 (Certificate-Bound Access Tokens): Implementation matches spec
No amendment needed

No Changes Needed:
- ARCHITECTURE.md (no structural changes)
- CLAUDE_AGENTS.md (agents still applicable)
- BGP_PROTOCOL.md (peering protocol unchanged)

New Pattern for CLAUDE.md:
Consider adding to AI Guidelines:
```
13. **Certificate-bound tokens** - Include cnf claim with x5t#S256 for peering tokens per ADR-0007
```
````
