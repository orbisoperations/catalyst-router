import type { AuthorizationDomain, DefaultDomain, Entity, EntityUid } from './types.js'

/**
 * A collection of entities optimized for lookup by Type and ID.
 *
 * This class wraps an array of Entities and provides methods to efficiently retrieve them.
 * It is commonly used to pass the set of relevant entities to the Authorization Engine.
 *
 * @template TDomain - The authorization domain the entities belong to.
 */
export class EntityCollection<TDomain extends AuthorizationDomain = DefaultDomain> {
  private entities: Entity<TDomain>[]
  private entityMap: Map<string, Entity<TDomain>>

  /**
   * Creates a new EntityCollection.
   *
   * @param entities - An array of initial entities to populate the collection.
   */
  constructor(entities: Entity<TDomain>[]) {
    this.entities = entities
    this.entityMap = new Map()

    for (const entity of entities) {
      // Cast to string because generic types might be stricter but runtime is string
      const type = entity.uid.type as string
      const key = this.getKey(type, entity.uid.id)
      this.entityMap.set(key, entity)
    }
  }

  private getKey(type: string, id: string): string {
    return `${type}::"${id}"`
  }

  /**
   * Creates a lightweight reference (EntityUid) for a specific entity type and ID.
   * Useful for constructing `AuthorizationRequest` objects (e.g., specifying the principal or resource).
   *
   * @param type - The entity type (must be a valid key of TDomain['Entities']).
   * @param id - The unique ID of the entity.
   * @returns An `EntityUid` object containing the type and id.
   */
  entityRef<K extends keyof TDomain['Entities']>(type: K, id: string): EntityUid<TDomain, K> {
    // We optionally verify it exists, but for flexible usage (e.g. entityReferencing
    // a resource not yet in the list), we simply return the UID structure.
    return { type, id } as EntityUid<TDomain, K>
  }

  /**
   * Retrieves a full `Entity` object from the collection by its type and ID.
   *
   * @param type - The entity type.
   * @param id - The entity ID.
   * @returns The `Entity` object if found, or `undefined`.
   */
  get<K extends keyof TDomain['Entities']>(type: K, id: string): Entity<TDomain> | undefined {
    return this.entityMap.get(this.getKey(type as string, id))
  }

  /**
   * Retrieves all entities in the collection as a flat array.
   *
   * @returns An array of all `Entity` objects.
   */
  getAll(): Entity<TDomain>[] {
    return this.entities
  }

  /**
   * Finds all entities of a specific type.
   *
   * @param type - The entity type to filter by.
   * @returns An array of `Entity` objects matching the specified type.
   */
  getByType<K extends keyof TDomain['Entities']>(type: K): Entity<TDomain>[] {
    return this.entities.filter((e) => e.uid.type === type)
  }
}
