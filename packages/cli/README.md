# Catalyst CLI

The Catalyst Node CLI provides command-line utilities for managing the Catalyst network node, including registering services and viewing metrics.

## Development

### Async Resource Management

We use specific TypeScript features for resource management.

> **await using Declaration**: This new syntax in JavaScript/TypeScript automatically calls the `[Symbol.asyncDispose]` method when the scope (e.g., function block) is exited, even if an error occurs.

Example usage:

```typescript
{
  await using client = await createClient()
  // client is automatically closed when this block is exited
}
```
