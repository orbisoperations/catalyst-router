/* eslint-disable */

import {
  AuthorizationEngine,
  EntityBuilderFactory,
  type AuthorizationDomain,
} from '../../src/index.js'

// 1. Define Domain
interface MarketDomain extends AuthorizationDomain {
  Actions: 'buy' | 'sell' | 'view_analytics'
  Entities: {
    User: { balance: number; kycVerified: boolean }
    Product: { price: number; sellerId: string; category: string }
    Order: { status: string; buyerId: string }
  }
}

// 2. Define Policies
const policies = `
  // Anyone can buy if they have verified KYC
  permit(
    principal,
    action == Action::"buy",
    resource
  )
  when { principal.kycVerified == true };

  // Seller can view analytics for their own products
  permit(
    principal,
    action == Action::"view_analytics",
    resource
  )
  when { resource.sellerId == principal.id };
`

// 3. Mock Data Models
class UserModel {
  constructor(
    public id: string,
    public balance: number,
    public kycStatus: 'verified' | 'pending'
  ) {}
}

class ProductModel {
  constructor(
    public id: string,
    public name: string,
    public price: number,
    public sellerId: string,
    public category: string
  ) {}
}

const dbUsers = [
  new UserModel('u1', 1000, 'verified'),
  new UserModel('u2', 500, 'pending'), // Cannot buy
]

const dbProducts = [new ProductModel('p1', 'Laptop', 999, 'u1', 'electronics')]

// 4. Setup Engine
const engine = new AuthorizationEngine<MarketDomain>('namespace Market', policies)
const factory = new EntityBuilderFactory<MarketDomain>()

// Register Mappers
// Notice we transform the DB model fields to match the policy expectations
factory
  .registerMapper('User', (user: UserModel) => ({
    id: user.id,
    attrs: {
      balance: user.balance,
      kycVerified: user.kycStatus === 'verified', // Transformation logic
    },
  }))
  .registerMapper('Product', (product: ProductModel) => ({
    id: product.id,
    attrs: {
      price: product.price,
      sellerId: product.sellerId,
      category: product.category,
    },
  }))

// 5. Build Entities
const builder = factory.createEntityBuilder()

// Add data from our "DB"
dbUsers.forEach((u) => builder.add('User', u))
dbProducts.forEach((p) => builder.add('Product', p))

const entities = builder.build()

// 6. Check Authorization
const requests = [
  { user: 'u1', action: 'buy', resource: 'p1', desc: 'Verified user buying' },
  { user: 'u2', action: 'buy', resource: 'p1', desc: 'Unverified user buying' },
  {
    user: 'u1',
    action: 'view_analytics',
    resource: 'p1',
    desc: 'Seller viewing own product analytics',
  },
  { user: 'u2', action: 'view_analytics', resource: 'p1', desc: 'Non-seller viewing analytics' },
]

console.log('--- Marketplace Access Checks ---')
requests.forEach((req) => {
  const result = engine.isAuthorized({
    principal: { type: 'User', id: req.user },
    action: { type: 'Action', id: req.action as any },
    resource: { type: 'Product', id: req.resource },
    entities,
  })

  if (result.type === 'evaluated') {
    console.log(`[${req.desc}] -> ${result.decision}`)
  } else {
    console.error(`[${req.desc}] -> Error: ${result.errors}`)
  }
})
