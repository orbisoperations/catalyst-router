import type { DetailedError } from '@cedar-policy/cedar-wasm/nodejs'
import type { z } from 'zod'
import type { EntityCollection } from './entity-collection.js'

// Base interface for defining a specific Domain's schema
/**
 * Defines the structure of an Authorization Domain, specifying valid Actions and PolicyEntity types.
 * This interface is meant to be extended to provide type safety for the Authorization Engine.
 *
 * @example
 * ```typescript
 * type MyDomains = [{
 *   Namespace: 'MyDomain';
 *   Actions: 'view' | 'edit' | 'delete';
 *   Entities: {
 *     User: { role: string; department: string };
 *     Document: { ownerId: string; public: boolean };
 *   };
 * }]
 * ```
 */
export type AuthorizationDomain = Array<{
  /**
   * The namespace of the domain.
   */
  Namespace: string | null
  /**
   * Defines the valid Actions within the domain.
   * Can be a union of string literals (simple actions) or a Record mapping Action IDs to their Context shape.
   */
  Actions: string | Record<string, unknown> | null // Union of valid action IDs OR Map of Action ID -> Context Shape
  /**
   * Defines the valid PolicyEntity types and their attribute shapes.
   * Map of PolicyEntity Type -> Attributes interface.
   */
  Entities: Record<string, Record<string, unknown>> | null // Map of Type -> Attributes
}>

// Default domain if none is specified (permissive fallback)
/**
 * A default, permissive domain used when no specific domain is provided.
 * Allows any string for Actions and any object structure for PolicyEntity attributes.
 */
export type DefaultPolicyDomain = [
  {
    Namespace: null
    Actions: string
    Entities: Record<string, Record<string, unknown>>
  },
]

export type PolicyEntityType<TDomain extends AuthorizationDomain> = TDomain[number] extends infer D
  ? D extends { Namespace: infer N; Entities: infer E }
    ? N extends null
      ? `${keyof E & string}`
      : `${N & string}::${keyof E & string}`
    : never
  : never

/**
 * Represents a unique identifier for an PolicyEntity in the Cedar policy engine.
 * Consists of a Type and an ID.
 *
 * @template TDomain - The authorization domain this entity belongs to.
 * @template K - The specific entity type key from the domain.
 */
export type PolicyEntityUid<TDomain extends AuthorizationDomain> = {
  /** The type of the entity (e.g., "User", "Document"). */
  type: PolicyEntityType<TDomain> // Ensure it's compatible with string
  /** The unique ID of the entity within its type. */
  id: string
}

/**
 * Represents a full PolicyEntity object with its attributes and parent relationships.
 *
 * @template TDomain - The authorization domain this entity belongs to.
 */
export type PolicyEntity<TDomain extends AuthorizationDomain> = {
  /** The unique identifier of the entity. */
  uid: PolicyEntityUid<TDomain>
  /** Key-value pairs representing the attributes of the entity. */
  attrs: Record<string, unknown>
  /** List of parent entities (e.g., UserGroup::"admin") this entity belongs to. */
  parents: PolicyEntityUid<TDomain>[]
}

export type PolicyActionType<N, A> = N extends null
  ? `Action::${A & string}`
  : N extends string
    ? `${N}::Action::${A & string}`
    : never

/**
 * Represents an authorization request to be evaluated by the engine.
 *
 * @template TDomain - The authorization domain.
 */
export type AuthorizationRequest<TDomain extends AuthorizationDomain = DefaultPolicyDomain> =
  TDomain[number] extends infer D
    ? D extends { Namespace: infer N; Actions: infer A }
      ? A extends string
        ? {
            principal: PolicyEntityUid<TDomain>
            // action: `${N & string}::Action::${A}`
            action: PolicyActionType<N, A>
            resource: PolicyEntityUid<TDomain>
            entities: PolicyEntity<TDomain>[] | EntityCollection<TDomain>
            context?: Record<string, unknown>
          }
        : A extends Record<string, unknown>
          ? {
              [K in keyof A]: {
                principal: PolicyEntityUid<TDomain>
                // action: `${N & string}::Action::${K & string}`
                action: PolicyActionType<N, K>
                resource: PolicyEntityUid<TDomain>
                entities: PolicyEntity<TDomain>[] | EntityCollection<TDomain>
              } & (Record<string, never> extends A[K] ? { context?: A[K] } : { context: A[K] })
            }[keyof A]
          : never
      : never
    : never

/**
 * Raw response from the authorization evaluation (internal use).
 */
export interface AuthorizationResponse {
  decision: 'allow' | 'deny'
  allowed: boolean
  reasons: string[]
  diagnostics: DetailedError[]
}

/**
 * Result of an authorization evaluation.
 */
export type AuthorizationEngineResult =
  | {
      /** Indicates a failure in the engine execution (e.g., internal error). */
      type: 'failure'
      /** List of error messages explaining the failure. */
      errors: string[]
    }
  | {
      /** Indicates the request was successfully evaluated. */
      type: 'evaluated'
      /** The authorization decision ('allow' or 'deny'). */
      decision: 'allow' | 'deny'
      /** Boolean shorthand for decision === 'allow'. */
      allowed: boolean
      /** IDs of the policies that determined the decision. */
      reasons: string[]
      /** Detailed diagnostics or warnings from the engine. */
      diagnostics: DetailedError[]
    }

/**
 * Interface for the Authorization Engine.
 *
 * @template TDomain - The authorization domain type.
 */
export interface IAuthorizationEngine<TDomain extends AuthorizationDomain = DefaultPolicyDomain> {
  /**
   * Validates the loaded policies against the schema.
   * @returns true if valid.
   * @throws Error if validation fails.
   */
  validatePolicies(): boolean
  /**
   * Evaluates an authorization request.
   * @param request - The authorization request containing principal, action, resource, context, and entities.
   * @returns The evaluation result (allowed/denied or failure).
   */
  isAuthorized(request: AuthorizationRequest<TDomain>): AuthorizationEngineResult
}

/**
 * Interface for objects that can provide a set of entities.
 * Implemented by `EntityBuilder` and custom data providers.
 */
export interface EntityProvider<TDomain extends AuthorizationDomain = DefaultPolicyDomain> {
  /**
   * Builds and returns the list of entities.
   * @returns An array of `PolicyEntity` objects or an `EntityCollection`.
   */
  build(): PolicyEntity<TDomain>[] | EntityCollection<TDomain>
}

/**
 * A function that maps arbitrary data into an entity structure (id, attributes, and parents).
 */
export type Mapper<TDomain extends AuthorizationDomain, T = unknown> = (data: T) => {
  id: string
  attrs: Record<string, unknown>
  parents?: PolicyEntityUid<TDomain>[]
}

/**
 * Registry of mappers for a given domain.
 */
export type MapperRegistry<TDomain extends AuthorizationDomain> = Map<
  PolicyEntityType<TDomain>,
  Mapper<TDomain>
>

/**
 * Configuration for adding an entity from a Zod schema.
 */
export interface ZodAddConfig<T extends z.ZodTypeAny, TDomain extends AuthorizationDomain> {
  idField: keyof z.infer<T>
  parents?: PolicyEntityUid<TDomain>[]
}

/**
 * Key used in EntityCollection map.
 */
export type EntityKey = string
