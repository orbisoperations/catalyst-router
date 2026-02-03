import type { z } from 'zod'
import { EntityCollection } from './entity-collection.js'
import type {
  AuthorizationDomain,
  DefaultDomain,
  Entity,
  EntityProvider,
  EntityUid,
} from './types.js'

/**
 * A function that maps arbitrary data into an entity structure (id, attributes, and parents).
 */
export type Mapper<TDomain extends AuthorizationDomain, T = unknown> = (data: T) => {
  id: string
  attrs: Record<string, unknown>
  parents?: EntityUid<TDomain>[]
}

// Separate Factory class to handle instantiation and type binding
/**
 * Factory for creating `EntityBuilder` instances.
 * Allows pre-registering mappers for specific entity types to streamline entity creation.
 *
 * @template TDomain - The authorization domain.
 */
export class EntityBuilderFactory<TDomain extends AuthorizationDomain = DefaultDomain> {
  private mappers: Partial<Record<keyof TDomain['Entities'] & string, Mapper<TDomain>>> = {}

  /**
   * Registers a mapper function for a specific entity type.
   * This allows you to add entities using just their raw data later.
   *
   * @template K - The entity type key.
   * @template T - The type of the input data expected by the mapper.
   * @param type - The entity type to register the mapper for.
   * @param mapper - The function that transforms raw data into entity properties.
   * @returns The factory instance for chaining.
   */
  registerMapper<K extends keyof TDomain['Entities'] & string, T>(
    type: K,
    mapper: Mapper<TDomain, T>
  ) {
    this.mappers[type] = mapper as Mapper<TDomain>
    return this
  }

  /**
   * Creates a new `EntityBuilder` instance initialized with the registered mappers.
   *
   * @returns A fresh `EntityBuilder`.
   */
  createEntityBuilder(): EntityBuilder<TDomain> {
    return new EntityBuilder<TDomain>(this.mappers)
  }
}

/**
 * A fluent builder for creating Cedar entities.
 * Supports adding entities manually, via Zod schemas, or using registered mappers.
 *
 * @template TDomain - The authorization domain.
 */
export class EntityBuilder<
  TDomain extends AuthorizationDomain = DefaultDomain,
> implements EntityProvider<TDomain> {
  private entities: Entity<TDomain>[] = []
  private currentEntity: Entity<TDomain> | null = null
  private mappers: Partial<Record<keyof TDomain['Entities'] & string, Mapper<TDomain>>>

  // Allow protected access for subclasses like User, but hide from general public API
  // to encourage factory usage if desired, though direct instantiation via `new EntityBuilder()`
  // is fine if the constructor is public.
  // Given the request to use a Factory Pattern where we "instantiate only one time the factory",
  // we'll keep this constructor accessible to the Factory.
  /**
   * Creates a new EntityBuilder.
   * Prefer using `EntityBuilderFactory.createEntityBuilder()` if you have registered mappers.
   *
   * @param mappers - Optional map of registered entity mappers.
   */
  public constructor(
    mappers: Partial<Record<keyof TDomain['Entities'] & string, Mapper<TDomain>>> = {}
  ) {
    this.mappers = mappers
  }

  // Keeping static create for backward compat/convenience if needed,
  // but the new request is for a stateful factory instance pattern.
  /**
   * Static convenience method to create an empty EntityBuilder.
   *
   * @returns A new EntityBuilder instance.
   */
  static create<T extends AuthorizationDomain = DefaultDomain>(): EntityBuilder<T> {
    return new EntityBuilder<T>()
  }

  /**
   * Adds an entity by validating and parsing data against a Zod schema.
   * Automatically extracts the ID and attributes from the validated data.
   *
   * @template T - The Zod schema type.
   * @param type - The entity type.
   * @param schema - The Zod schema to validate the data.
   * @param data - The raw data object.
   * @param config - Configuration specifying which field is the ID and optional parents.
   * @returns The builder instance for chaining.
   * @throws ZodError if validation fails.
   */
  addFromZod<T extends z.ZodTypeAny>(
    type: keyof TDomain['Entities'] & string,
    schema: T,
    data: z.infer<T>,
    config: { idField: keyof z.infer<T>; parents?: EntityUid<TDomain>[] }
  ): EntityBuilder<TDomain> {
    const validatedData = schema.parse(data)
    const id = String(validatedData[config.idField])
    const attributes: Record<string, unknown> = {}

    const dataObj = validatedData as Record<string, unknown>
    for (const [key, value] of Object.entries(dataObj)) {
      if (key === config.idField || key === 'id') continue

      if (value instanceof Date) {
        attributes[key] = value.toISOString()
      } else {
        attributes[key] = value
      }
    }

    this.entities.push({
      uid: { type, id },
      attrs: attributes,
      parents: config.parents || [],
    })

    // Set currentEntity to the newly created entity to allow chaining .addParent()
    const newEntity = this.entities[this.entities.length - 1] ?? null
    this.currentEntity = newEntity

    return this
  }

  /**
   * Starts building a new entity manually.
   * Use `.setAttributes()` and `.addParent()` to configure it further.
   *
   * @param type - The entity type.
   * @param id - The entity ID.
   * @returns The builder instance for chaining.
   */
  entity(type: keyof TDomain['Entities'] & string, id: string): EntityBuilder<TDomain> {
    const newEntity: Entity<TDomain> = {
      uid: { type, id },
      attrs: {},
      parents: [],
    }

    this.entities.push(newEntity)
    this.currentEntity = newEntity

    return this
  }

  /**
   * Sets attributes for the currently active entity (the one most recently added or started).
   *
   * @param attrs - Key-value map of attributes.
   * @returns The builder instance for chaining.
   * @throws Error if no entity is currently being built (call `.entity()` or `.add()` first).
   */
  setAttributes(attrs: Record<string, unknown>): EntityBuilder<TDomain> {
    if (!this.currentEntity) {
      throw new Error(
        'Cannot set attributes: No entity is currently being built. Call entity() first.'
      )
    }
    this.currentEntity.attrs = { ...this.currentEntity.attrs, ...attrs }
    return this
  }

  /**
   * Adds a parent to the currently active entity.
   *
   * @param type - The parent entity type.
   * @param id - The parent entity ID.
   * @returns The builder instance for chaining.
   * @throws Error if no entity is currently being built.
   */
  addParent(type: keyof TDomain['Entities'] & string, id: string): EntityBuilder<TDomain> {
    if (!this.currentEntity) {
      throw new Error('Cannot add parent: No entity is currently being built. Call entity() first.')
    }
    this.currentEntity.parents.push({ type, id })
    return this
  }

  /**
   * Adds entities from another EntityProvider (like another builder or a custom provider).
   * @param component - The provider to add entities from.
   * @returns The builder instance.
   */
  add(component: EntityProvider<TDomain>): EntityBuilder<TDomain>
  /**
   * Adds an entity using a registered mapper.
   * @param type - The entity type to create.
   * @param data - The raw data to pass to the registered mapper.
   * @returns The builder instance.
   * @throws Error if no mapper is registered for the given type.
   */
  add<K extends keyof TDomain['Entities'] & string, T>(type: K, data: T): EntityBuilder<TDomain>
  add(
    componentOrType: EntityProvider<TDomain> | (keyof TDomain['Entities'] & string),
    data?: unknown
  ): EntityBuilder<TDomain> {
    if (typeof componentOrType === 'string') {
      const type = componentOrType
      const mapper = this.mappers[type]
      if (!mapper) {
        throw new Error(`No mapper registered for entity type: ${type}`)
      }

      const { id, attrs, parents } = mapper(data)

      const newEntity = {
        uid: { type, id },
        attrs,
        parents: parents || [],
      }

      this.entities.push(newEntity)
      this.currentEntity = newEntity
      return this
    }

    const component = componentOrType
    const result = component.build()
    const componentEntities = Array.isArray(result)
      ? result
      : (result as EntityCollection<TDomain>).getAll
        ? (result as EntityCollection<TDomain>).getAll()
        : []

    this.entities.push(...componentEntities)

    // If exactly one entity was added, make it the current entity to allow chaining
    if (componentEntities.length === 1) {
      this.currentEntity = componentEntities[0] ?? null
    } else {
      this.currentEntity = null
    }

    return this
  }

  /**
   * Finalizes the build process and returns the collected entities.
   *
   * @returns An `EntityCollection` containing all added entities.
   */
  build(): EntityCollection<TDomain> {
    return new EntityCollection(this.entities)
  }
}
