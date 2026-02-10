import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { createYoga, createSchema } from 'graphql-yoga'

const PORT = parseInt(process.env.PORT || '4002', 10)
const SERVICE_NAME = 'product-api'

// Sample data
const products = [
  { id: '1', name: 'Laptop', price: 999.99, category: 'electronics', inStock: true },
  { id: '2', name: 'Headphones', price: 149.99, category: 'electronics', inStock: true },
  { id: '3', name: 'Coffee Mug', price: 12.99, category: 'home', inStock: false },
  { id: '4', name: 'Notebook', price: 8.99, category: 'office', inStock: true },
]

// GraphQL Schema
const schema = createSchema({
  typeDefs: /* GraphQL */ `
    type Product {
      id: ID!
      name: String!
      price: Float!
      category: String!
      inStock: Boolean!
    }

    type ServiceInfo {
      name: String!
      version: String!
      uptime: Float!
    }

    type Query {
      products: [Product!]!
      product(id: ID!): Product
      productsByCategory(category: String!): [Product!]!
      serviceInfo: ServiceInfo!
    }

    type Mutation {
      createProduct(name: String!, price: Float!, category: String!): Product!
      updateStock(id: ID!, inStock: Boolean!): Product
    }
  `,
  resolvers: {
    Query: {
      products: () => products,
      product: (_, { id }) => products.find((p) => p.id === id),
      productsByCategory: (_, { category }) => products.filter((p) => p.category === category),
      serviceInfo: () => ({
        name: SERVICE_NAME,
        version: '0.0.1',
        uptime: process.uptime(),
      }),
    },
    Mutation: {
      createProduct: (_, { name, price, category }) => {
        const newProduct = {
          id: String(products.length + 1),
          name,
          price,
          category,
          inStock: true,
        }
        products.push(newProduct)
        return newProduct
      },
      updateStock: (_, { id, inStock }) => {
        const product = products.find((p) => p.id === id)
        if (product) {
          product.inStock = inStock
        }
        return product
      },
    },
  },
})

// Create Yoga instance
const yoga = createYoga({
  schema,
  graphqlEndpoint: '/graphql',
  landingPage: false,
})

// Create Hono app
const app = new Hono()

// Health check endpoint
app.get('/health', (c) => c.json({ status: 'ok' }))

// Service info endpoint
app.get('/', (c) => {
  return c.json({
    service: SERVICE_NAME,
    description: 'Product catalog service',
    endpoints: {
      graphql: '/graphql',
      health: '/health',
    },
  })
})

// Mount GraphQL Yoga
app.on(['GET', 'POST'], '/graphql', async (c) => {
  const response = await yoga.handle(c.req.raw)
  return response
})

// Start server
console.log(`[${SERVICE_NAME}] Starting on port ${PORT}...`)

serve({
  fetch: app.fetch,
  port: PORT,
})

console.log(`[${SERVICE_NAME}] GraphQL endpoint: http://localhost:${PORT}/graphql`)
console.log(`[${SERVICE_NAME}] Health check: http://localhost:${PORT}/health`)
