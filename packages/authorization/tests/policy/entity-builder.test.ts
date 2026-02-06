import { describe, expect, it } from 'bun:test'
import { EntityBuilder } from '../../src/policy/src/entity-builder.js'

describe('EntityBuilder', () => {
  it('should build a single entity with basic properties', () => {
    const builder = new EntityBuilder()
    const entities = builder
      .entity('User', '123')
      .setAttributes({ name: 'Alice', age: 30 })
      .build()
      .getAll()

    expect(entities).toHaveLength(1)
    expect(entities[0]).toEqual({
      uid: { type: 'User', id: '123' },
      attrs: { name: 'Alice', age: 30 },
      parents: [],
    })
  })

  it('should build an entity with parents', () => {
    const builder = new EntityBuilder()
    const entities = builder
      .entity('User', '456')
      .addParent('Role', 'Admin')
      .addParent('Group', 'Devs')
      .build()
      .getAll()

    expect(entities).toHaveLength(1)
    expect(entities[0].parents).toEqual([
      { type: 'Role', id: 'Admin' },
      { type: 'Group', id: 'Devs' },
    ])
  })

  it('should build multiple entities', () => {
    const builder = new EntityBuilder()
    const entities = builder
      .entity('User', '1')
      .setAttributes({ role: 'admin' })
      .entity('User', '2')
      .setAttributes({ role: 'guest' })
      .build()
      .getAll()

    expect(entities).toHaveLength(2)
    expect(entities[0].uid.id).toBe('1')
    expect(entities[1].uid.id).toBe('2')
  })

  it('should handle complex entity relationships', () => {
    const builder = new EntityBuilder()
    const entities = builder
      .entity('Document', 'doc1')
      .setAttributes({ owner: 'alice', public: true })
      .addParent('Folder', 'root')
      .entity('Folder', 'root')
      .setAttributes({ type: 'system' })
      .build()
      .getAll()

    expect(entities).toHaveLength(2)

    const doc = entities.find((e) => e.uid.type === 'Document')
    expect(doc).toBeDefined()
    expect(doc?.attrs).toEqual({ owner: 'alice', public: true })
    expect(doc?.parents).toContainEqual({ type: 'Folder', id: 'root' })

    const folder = entities.find((e) => e.uid.type === 'Folder')
    expect(folder).toBeDefined()
    expect(folder?.attrs).toEqual({ type: 'system' })
  })

  it('should throw error if attributes are set before creating an entity', () => {
    const builder = new EntityBuilder()
    expect(() => {
      builder.setAttributes({ foo: 'bar' })
    }).toThrow()
  })

  it('should throw error if parent is added before creating an entity', () => {
    const builder = new EntityBuilder()
    expect(() => {
      builder.addParent('Group', '1')
    }).toThrow()
  })
})
