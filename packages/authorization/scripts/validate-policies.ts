import { AuthorizationEngine, CATALYST_SCHEMA, ALL_POLICIES } from '../src/index.js'

const engine = new AuthorizationEngine(CATALYST_SCHEMA, ALL_POLICIES)

try {
  engine.validatePolicies()
  console.log('Policies validated successfully')
} catch (error) {
  console.error('Error validating policies:', error)
  process.exit(1)
}
