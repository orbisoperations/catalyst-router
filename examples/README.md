# Example Services

Example GraphQL services for testing Catalyst Router routing.

## Services

### orders-api

- **Port**: 4001
- **Description**: Order management service
- **Queries**: `orders`, `order(id)`, `ordersByStatus(status)`, `serviceInfo`
- **Mutations**: `createOrder(productId, quantity, total)`, `updateOrderStatus(id, status)`

### product-api

- **Port**: 4002
- **Description**: Product catalog service
- **Queries**: `products`, `product(id)`, `productsByCategory(category)`, `serviceInfo`
- **Mutations**: `createProduct(name, price, category)`, `updateStock(id, inStock)`

## Usage

```bash
# Install dependencies
pnpm install

# Run orders-api
cd examples/orders-api
pnpm dev

# Run product-api (in another terminal)
cd examples/product-api
pnpm dev
```

## Testing

```bash
# Health check
curl http://localhost:4001/health
curl http://localhost:4002/health

# GraphQL query (orders-api)
curl -X POST http://localhost:4001/graphql \
  -H "Content-Type: application/json" \
  -d '{"query": "{ orders { id productId status total } }"}'

# GraphQL query (product-api)
curl -X POST http://localhost:4002/graphql \
  -H "Content-Type: application/json" \
  -d '{"query": "{ products { id name price } }"}'
```

## Environment Variables

| Variable | Default   | Description      |
| -------- | --------- | ---------------- |
| `PORT`   | 4001/4002 | HTTP server port |
