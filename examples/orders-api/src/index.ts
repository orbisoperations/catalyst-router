import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { createYoga, createSchema } from 'graphql-yoga'

const PORT = parseInt(process.env.PORT || '4001', 10)
const SERVICE_NAME = 'orders-api'

// Sample data
const orders = [
  {
    id: '1',
    productId: '1',
    quantity: 2,
    status: 'shipped',
    total: 1999.98,
    createdAt: '2024-01-15T10:30:00Z',
  },
  {
    id: '2',
    productId: '2',
    quantity: 1,
    status: 'pending',
    total: 149.99,
    createdAt: '2024-01-16T14:20:00Z',
  },
  {
    id: '3',
    productId: '4',
    quantity: 5,
    status: 'delivered',
    total: 44.95,
    createdAt: '2024-01-10T09:00:00Z',
  },
]

// GraphQL Schema
const schema = createSchema({
  typeDefs: /* GraphQL */ `
    enum OrderStatus {
      pending
      processing
      shipped
      delivered
      cancelled
    }

    type Order {
      id: ID!
      productId: ID!
      quantity: Int!
      status: OrderStatus!
      total: Float!
      createdAt: String!
    }

    type ServiceInfo {
      name: String!
      version: String!
      uptime: Float!
    }

    type Query {
      orders: [Order!]!
      order(id: ID!): Order
      ordersByStatus(status: OrderStatus!): [Order!]!
      serviceInfo: ServiceInfo!
    }

    type Mutation {
      createOrder(productId: ID!, quantity: Int!, total: Float!): Order!
      updateOrderStatus(id: ID!, status: OrderStatus!): Order
    }
  `,
  resolvers: {
    Query: {
      orders: () => orders,
      order: (_, { id }) => orders.find((o) => o.id === id),
      ordersByStatus: (_, { status }) => orders.filter((o) => o.status === status),
      serviceInfo: () => ({
        name: SERVICE_NAME,
        version: '0.0.1',
        uptime: process.uptime(),
      }),
    },
    Mutation: {
      createOrder: (_, { productId, quantity, total }) => {
        const newOrder = {
          id: String(orders.length + 1),
          productId,
          quantity,
          status: 'pending' as const,
          total,
          createdAt: new Date().toISOString(),
        }
        orders.push(newOrder)
        return newOrder
      },
      updateOrderStatus: (_, { id, status }) => {
        const order = orders.find((o) => o.id === id)
        if (order) {
          order.status = status
        }
        return order
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
    description: 'Order management service',
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
