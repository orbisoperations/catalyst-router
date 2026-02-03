import { AuthorizationEngine } from '@catalyst/authorization'
import fs from 'fs'

const schemaPath = process.env.CATALYST_AUTH_SCHEMA || './src/policies/schema.cedar'
const policiesPath = process.env.CATALYST_AUTH_POLICIES || './src/policies/policies.cedar'

const schema = fs.readFileSync(schemaPath, 'utf8')
const policies = fs.readFileSync(policiesPath, 'utf8')

console.log('Schema path:', schemaPath)
console.log('Policies path:', policiesPath)

const engine = new AuthorizationEngine(schema, policies)

try {
  engine.validatePolicies()
  console.log('Policies validated successfully')
} catch (error) {
  console.error('Error validating policies:', error)
  process.exit(1)
}
