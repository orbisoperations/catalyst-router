import type { z } from 'zod'
import type {
  AuthorizationDomain,
  DefaultPolicyDomain,
  EntityProvider,
  PolicyEntity,
  PolicyEntityType,
} from '../types.js'

/**
 * A generic adapter that takes a Zod Schema and data, validates it,
 * and converts it into a Cedar Entity.
 *
 * This class serves as a reference implementation of the `EntityProvider` interface.
 * You can implement `EntityProvider` to create custom entity sources, such as fetching
 * from a database or an external API.
 *
 * @deprecated Use `builder.addFromZod(...)` instead. This class is here as a reference implementation of the `EntityProvider` interface.
 */
export class GenericZodModel<
  T extends z.ZodTypeAny,
  TDomain extends AuthorizationDomain = DefaultPolicyDomain,
> implements EntityProvider<TDomain> {
  private typeName: PolicyEntityType<TDomain>
  private schema: T
  private data: z.infer<T>
  private idField: keyof z.infer<T>

  /**
   * Creates a new GenericZodModel instance
   * @param typeName - The type name of the entity
   * @param schema - The Zod schema for the entity
   * @param data - The data to parse
   * @param idField - The field to use as the ID
   * @throws ZodError if the data does not match the schema
   */
  constructor(
    typeName: PolicyEntityType<TDomain>,
    schema: T,
    data: z.infer<T>,
    idField: keyof z.infer<T>
  ) {
    this.typeName = typeName
    this.schema = schema
    this.data = this.schema.parse(data)
    this.idField = idField
  }

  build(): PolicyEntity<TDomain>[] {
    const id = String(this.data[this.idField])
    const attributes: Record<string, unknown> = {}

    // Map all fields except ID to attributes
    // Ensure this.data is treated as an object we can iterate over.
    // Zod inference might be 'unknown' or too strict depending on exact T definition.
    const dataObj = this.data as Record<string, unknown>
    for (const [key, value] of Object.entries(dataObj)) {
      if (key === this.idField) continue

      // Handle dates and other non-Cedar primitives if necessary
      if (value instanceof Date) {
        // Cedar doesn't support Date objects directly in attributes unless defined as extensions.
        // For now, convert to ISO string.
        attributes[key] = value.toISOString()
      } else {
        attributes[key] = value
      }
    }

    return [
      {
        uid: { type: this.typeName, id },
        attrs: attributes,
        parents: [],
      },
    ]
  }
}
