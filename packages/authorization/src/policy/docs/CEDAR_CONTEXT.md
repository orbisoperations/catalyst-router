# Cedar Context in Authorization Engine

## Summary

- **Purpose**: Provides dynamic, request-specific data (e.g., time, location, IP address) that is not part of the persistent entity store but is critical for policy decisions.
- **Mechanism**: Passed as a JSON object in the `isAuthorized` request.
- **Usage**: Accessible in Cedar policies via the `context` variable (e.g., `context.ip_address`, `context.time`).
- **Flexibility**: The structure is defined by your Cedar schema but the SDK treats it as a flexible record, allowing you to pass any serializable data.
- **Type Safety**: While the SDK accepts `Record<string, unknown>`, it is best practice to define strict types in your application code to match your Cedar schema.

---

## Introduction

In Cedar, authorization decisions often depend on environmental factors or attributes of the request itself that aren't stored as part of your resource or principal entities. This data is called **Context**.

Common examples of Context include:

- The IP address of the requester.
- The time of day the request was made.
- Whether the user authenticated with Multi-Factor Authentication (MFA).
- The intent or strength of the authentication session.

## Usage in SDK

The `AuthorizationEngine` accepts a `context` property as part of the `AuthorizationRequest` object. This context is passed directly to the Cedar evaluation engine.

### Code Example

```typescript
import { AuthorizationEngine } from '@catalyst/authorization'

// 1. Define your policy that uses context
const policies = `
  permit(principal, action, resource)
  when {
    context.mfa_enabled == true &&
    context.source_ip like "10.*"
  };
`

const engine = new AuthorizationEngine(schema, policies)

// 2. Pass context during authorization check
const result = engine.isAuthorized({
  principal: entities.entityRef('User', 'alice'),
  action: { type: 'Action', id: 'view_dashboard' },
  resource: entities.entityRef('Dashboard', 'main'),
  entities: entities.getAll(),
  // CONTEXT OBJECT HERE
  context: {
    mfa_enabled: true,
    source_ip: '10.0.0.5',
    request_timestamp: Date.now(),
  },
})

if (result.response.decision === 'allow') {
  console.log('Access granted based on MFA and IP context.')
}
```

## Data Flow: How Context Moves

The journey of the Context data through the SDK is straightforward and designed to be low-friction:

1. **Application Layer**: You construct a plain JavaScript object representing the context.
2. **Authorization Request**: This object is attached to the `AuthorizationRequest` interface passed to `engine.isAuthorized()`.
3. **Engine Processing**: The `AuthorizationEngine` receives the request. It does **not** validate the context against the schema at runtime (this is handled by the Cedar engine during evaluation).
4. **Cedar Wasm Interface**: The engine casts the context to the format expected by the underlying Cedar Wasm module.
5. **Policy Evaluation**: The Cedar engine evaluates your policies. When a policy references `context.someAttribute`, it looks up the value in the object you provided.
   - If the attribute is missing or the wrong type, the policy evaluation for that specific rule may error or fail to match, typically resulting in a `deny` (depending on how your policy is written).

## Best Practices

### 1. Match Your Schema

Ensure the context object you pass matches the `type` definition in your Cedar schema.

**Cedar Schema:**

```cedar
type RequestContext = {
  ip: ipaddr,
  timestamp: Long
};

action view appliesTo {
  context: RequestContext
};
```

**TypeScript:**

```typescript
// Good: Matches schema types
context: {
  ip: '192.168.1.1', // Cedar 'ipaddr' parses strings
  timestamp: 1678888888
}
```

### 2. Keep It Minimal

Only pass data that is actually relevant to your authorization policies. Context is ephemeral and evaluated per-request; sending large, deeply nested objects can impact performance and readability.

### 3. Type It in Application Code

Since the SDK's `context` type is broad (`Record<string, unknown>`), define your own TypeScript interfaces for context to catch errors early.

```typescript
interface MyAppContext {
  remoteAddr: string;
  userAgent: string;
  authTime: number;
}

const context: MyAppContext = {
  remoteAddr: req.ip,
  userAgent: req.headers['user-agent'],
  authTime: session.authTime
};

engine.isAuthorized({ ..., context });
```

### 4. Treat Context as Trusted

The Authorization Engine trusts the context you provide. Ensure that any sensitive context data (like `is_admin_override` or `mfa_verified`) comes from a trusted source in your application (e.g., your authentication middleware) and cannot be spoofed by the user.
