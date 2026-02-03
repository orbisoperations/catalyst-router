/**
 * @catalyst-node/authorization-engine
 *
 * A TypeScript wrapper around the Cedar Policy Engine, providing type-safe entity building,
 * fluent APIs, and robust authorization checks.
 *
 * @example
 * ```typescript
 * import { AuthorizationEngine, EntityBuilderFactory } from '@catalyst-node/authorization-engine';
 *
 * // 1. Define your Domain
 * interface MyDomain {
 *   Actions: 'view' | 'edit';
 *   Entities: {
 *     User: { role: string };
 *     UserGroup: { name: string };
 *     Document: { owner: string };
 *   };
 * }
 *
 * // 2. Define Policies
 * const policies = `
 *   permit(
 *     principal,
 *     action == Action::"view",
 *     resource
 *   )
 *   when { resource.owner == principal.id };
 *
 *   permit(
 *     principal,
 *     action == Action::"view",
 *     resource
 *   )
 *   when { principal in UserGroup::"admin" };
 * `;
 *
 * // 3. Initialize Engine
 * const engine = new AuthorizationEngine<MyDomain>('namespace MyApp', policies);
 *
 * // 4. Create Factory & Build Entities
 * const factory = new EntityBuilderFactory<MyDomain>();
 * const builder = factory.createEntityBuilder();
 *
 * builder
 *   .entity('UserGroup', 'admin')
 *   .setAttributes({ name: 'Administrators' })
 *
 *   .entity('User', 'alice')
 *   .setAttributes({ role: 'admin' })
 *   .addParent('UserGroup', 'admin') // Alice is part of Admin group
 *
 *   .entity('Document', 'doc1')
 *   .setAttributes({ owner: 'bob' });
 *
 * // 5. Check Authorization
 * const result = engine.isAuthorized(
 *   {
 *     principal: { type: 'User', id: 'alice' },
 *     action: { type: 'Action', id: 'view' },
 *     resource: { type: 'Document', id: 'doc1' }, // Owned by bob, but Alice is admin
 *     context: {},
 *     entities: builder.build(),
 *   },
 *   builder.build()
 * );
 * ```
 */

export * from './authorization-engine.js'
export * from './definitions/index.js'
export * from './entity-builder.js'
export * from './entity-collection.js'
export * from './providers/GenericZodModel.js'
export * from './types.js'
export * from './definitions/index.js'
