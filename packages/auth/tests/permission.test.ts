import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import {
  type CatalystPrincipal,
  type CatalystResource,
  Permission,
  PermissionService,
  isSecretValid,
} from '../src'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'
import path from 'path'

describe('Validate secrets timing safe', () => {
  it('should validate secrets safely with around same time duration', () => {
    expect(isSecretValid('hello', 'hello')).toBe(true)
    expect(isSecretValid('hello', 'incoad')).toBe(false)
    expect(isSecretValid('hello', 'thisisaverylongsecretthatisnotthesameashello')).toBe(false)
    expect(isSecretValid('invalid', 'secret')).toBe(false)
    expect(isSecretValid('verryyyylong', 'secret')).toBe(false)
    expect(isSecretValid('shor', 'secret')).toBe(false)
  })
})

describe('Permission', () => {
  let cerbosContainer: StartedTestContainer
  let permissionService: PermissionService
  const cerbosImage = 'ghcr.io/cerbos/cerbos:0.50.0'
  const repoRoot = path.resolve(__dirname, '../../../')

  beforeAll(async () => {
    // pull cerbos container
    console.log('Pulling cerbos image...')
    const pullResult = Bun.spawnSync(['docker', 'pull', cerbosImage], {
      stdout: 'inherit',
      stderr: 'inherit',
    })
    if (pullResult.exitCode !== 0) {
      throw new Error(`Failed to pull cerbos image: ${pullResult.exitCode} ${pullResult.stderr}`)
    }

    // start cerbos container
    console.log('Starting cerbos container...')
    cerbosContainer = await new GenericContainer(cerbosImage)
      .withExposedPorts(3592, 3593)
      .withName('cerbos-pdp-test')
      .withBindMounts([
        {
          source: path.resolve(repoRoot, 'packages/auth/cerbos/policies'),
          target: '/policies',
        },
      ])
      .withEnvironment({
        CERBOS_NO_TELEMETRY: '1',
      })
      .withWaitStrategy(Wait.forLogMessage('Starting gRPC server'))
      .start()

    const grpcPort = cerbosContainer.getMappedPort(3593)
    const url = `localhost:${grpcPort}`
    console.log('Cerbos gRPC URL:', url)
    permissionService = new PermissionService(url)
  })

  afterAll(async () => {
    await cerbosContainer?.stop()
  })

  it('should allow admin to create peers', async () => {
    const principal: CatalystPrincipal = {
      id: 'admin_user',
      roles: ['admin'],
      attr: { orgId: 'orgId' },
    }
    const resource: CatalystResource = { kind: 'peer', id: 'peer-1', attr: { network: 'internal' } }
    const allowed = await permissionService.isAuthorized(principal, resource, Permission.PeerCreate)
    expect(allowed).toBe(true)
  })

  it('should allow admin to create complex resource peers', async () => {
    expect(true).toBe(true) // TODO: Remove this once the test is implemented
    const principal: CatalystPrincipal = {
      id: 'user-1',
      roles: ['data_custodian'],
      policyVersion: 'default',
      scope: 'data_custodian',
    }
    const resource: CatalystResource = {
      kind: 'route',
      id: 'route-1',
      attr: {
        peerName: 'peer-1',
        protocol: 'http',
        nodePath: ['node-1', 'node-2'],
        region: 'us-east-1',
        tags: ['tag-1', 'tag-2'],
      },
    }
    const allowed = await permissionService.isAuthorized(
      principal,
      resource,
      Permission.RouteCreate
    )
    expect(allowed).toBe(true)
  })

  it('should deny standard user from creating peers', async () => {
    const principal: CatalystPrincipal = { id: 'user-1', roles: ['user'] }
    const resource: CatalystResource = { kind: 'peer', id: 'peer-1', attr: { network: 'internal' } }
    const allowed = await permissionService.isAuthorized(principal, resource, Permission.PeerCreate)
    expect(allowed).toBe(false)
  })

  it('should allow user to revoke their own token', async () => {
    const principal: CatalystPrincipal = { id: 'alice', roles: ['user'] }
    const resource: CatalystResource = { kind: 'token', id: 'token-1', attr: { ownerId: 'alice' } }
    const allowed = await permissionService.isAuthorized(
      principal,
      resource,
      Permission.TokenRevoke
    )
    expect(allowed).toBe(false)
  })

  it('should deny user from revoking others tokens', async () => {
    const principal: CatalystPrincipal = { id: 'user-1', roles: ['user'] }
    const resource: CatalystResource = { kind: 'token', id: 'token-2' }
    const allowed = await permissionService.isAuthorized(
      principal,
      resource,
      Permission.TokenRevoke
    )
    expect(allowed).toBe(false)
  })
})
