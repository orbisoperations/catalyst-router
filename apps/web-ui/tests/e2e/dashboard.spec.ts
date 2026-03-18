import { test, expect } from '@playwright/test'

/**
 * Playwright E2E tests for the web-ui dashboard.
 *
 * Verifies the dashboard renders correctly with data from the
 * mock orchestrator started by test-server.ts (via playwright.config webServer).
 *
 * Prerequisites: `pnpm build:frontend` must have been run before these tests.
 */

test.describe('Dashboard E2E', () => {
  test('renders System Status header', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'System Status' })).toBeVisible()
    await expect(page.getByText('Service health overview')).toBeVisible()
  })

  test('displays service groups with health status', async ({ page }) => {
    await page.goto('/')

    // Wait for services to load (loading spinner disappears)
    await expect(page.getByText('polling services...')).toBeHidden({ timeout: 10000 })

    // Service groups should be visible
    await expect(page.getByText('Control Plane')).toBeVisible()
    await expect(page.getByText('Data Plane')).toBeVisible()
    await expect(page.getByText('Federation')).toBeVisible()

    // At least one "operational" pill should appear
    await expect(page.getByText(/\d+\/\d+ operational/).first()).toBeVisible()
  })

  test('displays service cards with names', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('polling services...')).toBeHidden({ timeout: 10000 })

    // Individual service names should appear
    await expect(page.getByText('orchestrator')).toBeVisible()
    await expect(page.getByText('auth')).toBeVisible()
    await expect(page.getByText('envoy-service')).toBeVisible()
    await expect(page.getByText('gateway')).toBeVisible()
  })

  test('displays peers section with connected peer', async ({ page }) => {
    await page.goto('/')

    // Wait for state to load (peers come from /api/state)
    await expect(page.getByText('Peers')).toBeVisible({ timeout: 15000 })

    // Peer name and status should be visible
    await expect(page.getByText('node-b.dev.catalyst.local')).toBeVisible()
    await expect(page.getByText('connected')).toBeVisible()
    await expect(page.getByText('dev.catalyst.local', { exact: true })).toBeVisible()
  })

  test('no credential fields visible in page content', async ({ page }) => {
    await page.goto('/')

    // Wait for data to load
    await expect(page.getByText('polling services...')).toBeHidden({ timeout: 10000 })
    await expect(page.getByText('Peers')).toBeVisible({ timeout: 15000 })

    // The page text should not contain any credential or internal fields
    const bodyText = await page.textContent('body')
    expect(bodyText).not.toContain('peerToken')
    expect(bodyText).not.toContain('holdTime')
    expect(bodyText).not.toContain('lastSent')
    expect(bodyText).not.toContain('lastReceived')
    expect(bodyText).not.toContain('isStale')
  })

  test('Adapters tab shows local routes', async ({ page }) => {
    await page.goto('/')

    // Click on Adapters tab
    await page.getByRole('button', { name: 'Adapters' }).click()

    // Wait for adapters to load
    await expect(page.getByText('loading adapters...')).toBeHidden({ timeout: 10000 })

    // Should show local routes section
    await expect(page.getByText('Local Routes')).toBeVisible()
    await expect(page.getByText('books-api')).toBeVisible()
    await expect(page.getByText('http:graphql')).toBeVisible()
  })

  test('tab switching works correctly', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('polling services...')).toBeHidden({ timeout: 10000 })

    // Start on Services tab
    await expect(page.getByRole('button', { name: 'Services' })).toBeVisible()

    // Switch to Adapters
    await page.getByRole('button', { name: 'Adapters' }).click()
    await expect(page.getByText('loading adapters...')).toBeHidden({ timeout: 10000 })
    await expect(page.getByText('Local Routes')).toBeVisible()

    // Switch back to Services
    await page.getByRole('button', { name: 'Services' }).click()
    await expect(page.getByText('Control Plane')).toBeVisible()
  })
})
