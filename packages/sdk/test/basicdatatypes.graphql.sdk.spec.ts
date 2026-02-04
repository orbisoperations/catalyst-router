import { describe, it, expect, beforeAll } from 'vitest'
import { createSchema, createYoga } from 'graphql-yoga'
import { FileStorage } from '../src/storage/file'
import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'

describe('Basic Data Types SDK Test', () => {
  // Use a persistent fixtures directory nearby the test file
  const testDir = join(__dirname, 'fixtures')
  const testFile = 'test-data.json'

  const testObject = {
    stringField: 'test string',
    intField: 42,
    floatField: 3.14,
    boolField: true,
    listField: ['a', 'b', 'c'],
    nestedField: {
      subField: 'nested',
    },
  }

  beforeAll(async () => {
    await mkdir(testDir, { recursive: true })
    // Write the file once; since we don't delete it, it persists.
    // Overwriting ensures the content is always correct for the test.
    await writeFile(join(testDir, testFile), JSON.stringify(testObject))
  })

  it('should return complex object from file storage', async () => {
    const storage = new FileStorage(testDir)

    // Custom server that uses storage to serve the test object
    const typeDefs = /* GraphQL */ `
      type Nested {
        subField: String
      }
      type ComplexData {
        stringField: String
        intField: Int
        floatField: Float
        boolField: Boolean
        listField: [String]
        nestedField: Nested
      }
      type Query {
        complexData: ComplexData
      }
    `

    const resolvers = {
      Query: {
        complexData: async () => {
          const data = await storage.get(testFile)
          if (!data) throw new Error('Data not found')
          return JSON.parse(new TextDecoder().decode(data))
        },
      },
    }

    const yoga = createYoga({
      schema: createSchema({ typeDefs, resolvers }),
    })

    const response = await yoga.fetch('http://localhost:4000/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `
            { 
                complexData { 
                    stringField 
                    intField 
                    floatField 
                    boolField 
                    listField
                    nestedField {
                        subField
                    }
                } 
            }`,
      }),
    })

    const result = await response.json()
    expect(result.data.complexData).toEqual(testObject)
  })
})
