import type { DetailedError } from '@cedar-policy/cedar-wasm/nodejs'
import type { EntityCollection } from './entity-collection.js'

/**
 * Standardized roles for the Catalyst system.
 * These serve as primary Principal Types in Cedar.
 */
export enum Role {
  ADMIN = 'ADMIN',
  NODE = 'NODE',
  NODE_CUSTODIAN = 'NODE_CUSTODIAN',
  DATA_CUSTODIAN = 'DATA_CUSTODIAN',
  USER = 'USER',
}

/**
 * Standardized actions for the Catalyst system.
 */
export enum Action {
  LOGIN = 'LOGIN',
  MANAGE = 'MANAGE',
  IBGP_CONNECT = 'IBGP_CONNECT',
  IBGP_DISCONNECT = 'IBGP_DISCONNECT',
  IBGP_UPDATE = 'IBGP_UPDATE',
  PEER_CREATE = 'PEER_CREATE',
  PEER_UPDATE = 'PEER_UPDATE',
  PEER_DELETE = 'PEER_DELETE',
  ROUTE_CREATE = 'ROUTE_CREATE',
  ROUTE_DELETE = 'ROUTE_DELETE',
  TOKEN_CREATE = 'TOKEN_CREATE',
  TOKEN_REVOKE = 'TOKEN_REVOKE',
  TOKEN_LIST = 'TOKEN_LIST',
}

/**
 * Default role-to-action permissions mapping.
 * Used as a reference for policy generation and documentation.
 */
export const ROLE_PERMISSIONS: Record<Role, Action[]> = {
  [Role.ADMIN]: Object.values(Action),
  [Role.NODE]: [Action.IBGP_CONNECT, Action.IBGP_DISCONNECT, Action.IBGP_UPDATE],
  [Role.NODE_CUSTODIAN]: [
    Action.PEER_CREATE,
    Action.PEER_UPDATE,
    Action.PEER_DELETE,
    Action.IBGP_CONNECT,
    Action.IBGP_DISCONNECT,
    Action.IBGP_UPDATE,
  ],
  [Role.DATA_CUSTODIAN]: [Action.ROUTE_CREATE, Action.ROUTE_DELETE],
  [Role.USER]: [Action.LOGIN],
}

// Base interface for defining a specific Domain's schema
/**
 * Defines the structure of an Authorization Domain, specifying valid Actions and Entity types.
 * This interface is meant to be extended to provide type safety for the Authorization Engine.
 *
 * @example
 * ```typescript
 * interface MyDomain {
 *   Actions: 'view' | 'edit' | 'delete';
 *   Entities: {
 *     User: { role: string; department: string };
 *     Document: { ownerId: string; public: boolean };
 *   };
 * }
 * ```
 */
export interface AuthorizationDomain {
  /**
   * Defines the valid Actions within the domain.
   * Can be a union of string literals (simple actions) or a Record mapping Action IDs to their Context shape.
   */
  Actions: string | Record<string, unknown> // Union of valid action IDs OR Map of Action ID -> Context Shape
  /**
   * Defines the valid Entity types and their attribute shapes.
   * Map of Entity Type -> Attributes interface.
   */
  Entities: Record<string, Record<string, unknown>> // Map of Type -> Attributes
}

// Default domain if none is specified (permissive fallback)
/**
 * A default, permissive domain used when no specific domain is provided.
 * Allows any string for Actions and any object structure for Entity attributes.
 */
export interface DefaultDomain extends AuthorizationDomain {
  Actions: string
  Entities: Record<string, Record<string, unknown>>
}

/**
 * Represents a unique identifier for an Entity in the Cedar policy engine.
 * Consists of a Type and an ID.
 *
 * @template TDomain - The authorization domain this entity belongs to.
 * @template K - The specific entity type key from the domain.
 */
export interface EntityUid<
  TDomain extends AuthorizationDomain = DefaultDomain,
  K extends keyof TDomain['Entities'] = keyof TDomain['Entities'],
> {
  /** The type of the entity (e.g., "User", "Document"). */
  type: K & string // Ensure it's compatible with string
  /** The unique ID of the entity within its type. */
  id: string
}

/**
 * Represents a full Entity object with its attributes and parent relationships.
 *
 * @template TDomain - The authorization domain this entity belongs to.
 */
export interface Entity<TDomain extends AuthorizationDomain = DefaultDomain> {
  /** The unique identifier of the entity. */
  uid: EntityUid<TDomain>
  /** Key-value pairs representing the attributes of the entity. */
  attrs: Record<string, unknown>
  /** List of parent entities (e.g., UserGroup::"admin") this entity belongs to. */
  parents: EntityUid<TDomain>[]
}

// Helper type to extract Action IDs
/**
 * Helper type to extract valid Action IDs from an Authorization Domain.
 * Handles both simple string unions and Record definitions.
 */
export type ActionId<TDomain extends AuthorizationDomain> = TDomain['Actions'] extends string
  ? TDomain['Actions']
  : keyof TDomain['Actions'] & string

// Helper type to extract Context for a given Action ID
/**
 * Helper type to extract the required Context shape for a specific Action ID.
 * Returns `Record<string, unknown>` (any object) if actions are defined as simple strings.
 */
export type ActionContext<
  TDomain extends AuthorizationDomain,
  TActionID extends ActionId<TDomain>,
> =
  TDomain['Actions'] extends Record<string, unknown>
    ? TDomain['Actions'][TActionID]
    : Record<string, unknown>

/**
 * Represents an authorization request to be evaluated by the engine.
 *
 * @template TDomain - The authorization domain.
 * @template TActionID - The specific action being requested.
 */
export type AuthorizationRequest<
  TDomain extends AuthorizationDomain = DefaultDomain,
  TActionID extends ActionId<TDomain> = ActionId<TDomain>,
> = {
  /** The entity performing the action (who?). */
  principal: EntityUid<TDomain>
  /** The action being performed (what?). */
  action: { type: 'Action'; id: TActionID }
  /** The entity the action is being performed on (on what?). */
  resource: EntityUid<TDomain>
  // entities: Array<EntityUid>;
  // context: AuthorizationCall["context"];
  /**
   * Additional entities to include in the evaluation context.
   * Can be a raw array of Entities or an `EntityCollection`.
   */
  entities: Entity<TDomain>[] | EntityCollection<TDomain>
} & (Record<string, never> extends ActionContext<TDomain, TActionID>
  ? {
      /**
       * Contextual information for the request (optional if the action requires no context).
       */
      context?: ActionContext<TDomain, TActionID>
    }
  : {
      /**
       * Contextual information for the request (required if the action defines a context shape).
       */
      context: ActionContext<TDomain, TActionID>
    })

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
export interface IAuthorizationEngine<TDomain extends AuthorizationDomain = DefaultDomain> {
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
  isAuthorized<TActionID extends ActionId<TDomain>>(
    request: AuthorizationRequest<TDomain, TActionID>
  ): AuthorizationEngineResult
}

/**
 * Interface for objects that can provide a set of entities.
 * Implemented by `EntityBuilder` and custom data providers.
 */
export interface EntityProvider<TDomain extends AuthorizationDomain = DefaultDomain> {
  /**
   * Builds and returns the list of entities.
   * @returns An array of `Entity` objects or an `EntityCollection`.
   */
  build(): Entity<TDomain>[] | EntityCollection<TDomain>
}
