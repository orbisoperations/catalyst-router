import type {
  Context as CedarContext,
  Entities as CedarEntities,
  EntityUid as CedarEntityUid,
} from '@cedar-policy/cedar-wasm/nodejs'
import * as cedar from '@cedar-policy/cedar-wasm/nodejs'
import { type EntityBuilder, EntityBuilderFactory } from './entity-builder.js'
import { EntityCollection } from './entity-collection.js'
import type {
  ActionId,
  AuthorizationDomain,
  AuthorizationEngineResult,
  AuthorizationRequest,
  DefaultDomain,
  IAuthorizationEngine,
} from './types.js'

/**
 * The main entry point for the Authorization Engine.
 * Responsible for managing the Cedar policy engine, validating policies, and evaluating authorization requests.
 *
 * @template TDomain - The authorization domain structure (Actions and Entities).
 */
export class AuthorizationEngine<
  TDomain extends AuthorizationDomain = DefaultDomain,
> implements IAuthorizationEngine<TDomain> {
  private schema: string
  private policies: string
  private _entityBuilderFactory: EntityBuilderFactory<TDomain>

  /**
   * Creates a new Authorization Engine instance.
   *
   * @param schema - The Cedar schema definition as a string.
   * @param policies - The Cedar policies as a string.
   */
  constructor(schema: string, policies: string) {
    this.schema = schema
    this.policies = policies
    this._entityBuilderFactory = new EntityBuilderFactory<TDomain>()
  }

  /**
   * Validates the loaded policies against the schema using the Cedar validator.
   *
   * @param opts - The validation options.
   * @param opts.failOnWarnings - Whether to fail on warnings. Defaults to `true`.
   * @throws {Error} If cedar validation `failure` response is returned.
   * @throws {Error} If validation errors are present.
   * @throws {Error} If warnings are present and `failOnWarnings` is `true`.
   * @returns {boolean} `true` if policies are valid.
   */
  validatePolicies(): boolean {
    const validationAnswer = cedar.validate({
      schema: this.schema,
      policies: { staticPolicies: this.policies },
      validationSettings: { mode: 'strict' },
    })
    if (validationAnswer.type === 'failure') {
      throw new Error(validationAnswer.errors.map((error) => error.message).join('\n'))
    }
    const hasError = validationAnswer.validationErrors.length > 0
    const hasWarning = validationAnswer.validationWarnings.length > 0
    const hasOtherWarnings = validationAnswer.otherWarnings.length > 0

    if (hasError) console.error(JSON.stringify(validationAnswer.validationErrors, null, 2))
    if (hasWarning) console.warn(JSON.stringify(validationAnswer.validationWarnings, null, 2))
    if (hasOtherWarnings) console.warn(JSON.stringify(validationAnswer.otherWarnings, null, 2))
    if (opts.failOnWarnings && (hasWarning || hasOtherWarnings)) {
      throw new Error(
        'Policies have warnings: Cedar validation returned warnings. Use `failOnWarnings: false` to ignore warnings.'
      )
    }
    if (hasError) {
      throw new Error('Policies are invalid: Cedar validation returned errors.')
    }
    return true
  }

  /**
   * Evaluates an authorization request to determine if an action is allowed.
   *
   * @template TActionID - The specific action ID from the domain.
   * @param request - The authorization request containing principal, action, resource, context, and entities.
   * @returns An `AuthorizationEngineResult` indicating 'allow' or 'deny', with reasons and diagnostics.
   */
  isAuthorized<TActionID extends ActionId<TDomain>>(
    request: AuthorizationRequest<TDomain, TActionID>
  ): AuthorizationEngineResult {
    // Cast to specific Cedar types to bypass the strict typing mismatch with cedar-wasm types
    // The runtime structure is correct, but TS sees the generic TDomain as incompatible
    // with the stricter types expected by cedar.isAuthorized
    const entities = request.entities
    const cedarEntities = (entities instanceof EntityCollection
      ? entities.getAll()
      : entities) as unknown as CedarEntities
    const cedarPrincipal = request.principal as unknown as CedarEntityUid
    const cedarAction = request.action as unknown as CedarEntityUid
    const cedarResource = request.resource as unknown as CedarEntityUid
    // Context needs explicit casting because 'unknown' values aren't assignable to CedarValueJson
    // Default to empty object if context is not provided (optional)
    const cedarContext = (request.context || {}) as unknown as CedarContext

    const authorizationAnswer = cedar.isAuthorized({
      // dynamic parameters based on the request
      principal: cedarPrincipal,
      action: cedarAction,
      resource: cedarResource,
      context: cedarContext,
      entities: cedarEntities,
      // internal static parameters based on the internal Authorization Engine state
      policies: { staticPolicies: this.policies },
      schema: this.schema,
    })

    if (authorizationAnswer.type === 'failure') {
      return {
        type: 'failure',
        errors: authorizationAnswer.errors.map((e) => e.message),
      }
    }

    const { decision: rawDecision, diagnostics } = authorizationAnswer.response
    const decision = rawDecision as 'allow' | 'deny'
    return {
      type: 'evaluated',
      decision,
      allowed: decision === 'allow',
      reasons: (Array.isArray(diagnostics) ? diagnostics : []).map((d) => d.message),
      diagnostics: Array.isArray(diagnostics) ? diagnostics : [],
    }
  }

  /**
   * Creates a new `EntityBuilder` initialized for this domain.
   * Use this to create entities compatible with the engine.
   *
   * @returns A new `EntityBuilder` instance.
   */
  getEntityBuilder(): EntityBuilder<TDomain> {
    return this._entityBuilderFactory.createEntityBuilder()
  }

  /**
   * Access the underlying `EntityBuilderFactory`.
   * Useful for registering mappers globally for this engine instance.
   */
  get entityBuilderFactory(): EntityBuilderFactory<TDomain> {
    return this._entityBuilderFactory
  }
}
