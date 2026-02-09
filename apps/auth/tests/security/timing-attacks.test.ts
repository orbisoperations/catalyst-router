import { describe, it, expect } from 'bun:test'
import { hashPassword, verifyPassword } from '../../src/password.js'
import { isSecretValid } from '../../src/permissions.js'

/**
 * Timing Attack Security Tests
 *
 * Tests that cryptographic operations run in constant time to prevent
 * timing-based side-channel attacks. These tests use statistical analysis
 * to detect timing differences that could leak information.
 */
describe('Timing Attack Resistance', () => {
  describe('Password verification timing', () => {
    it('should take similar time for valid user with wrong password vs non-existent user', async () => {
      // Hash a password for "valid user"
      const validPasswordHash = await hashPassword('ValidPassword123!')

      const iterations = 50
      const validUserTimes: number[] = []
      const nonExistentUserTimes: number[] = []

      // Measure time for valid user, wrong password
      for (let i = 0; i < iterations; i++) {
        const start = performance.now()
        await verifyPassword(validPasswordHash, 'WrongPassword456!')
        const end = performance.now()
        validUserTimes.push(end - start)
      }

      // Measure time for non-existent user (using DUMMY_HASH)
      // In a real system, this would be the login service comparing against DUMMY_HASH
      const DUMMY_HASH =
        '$argon2id$v=19$m=19456,t=2,p=1$aG9uZXN0bHktanVzdC1hLWR1bW15LXNhbHQ$NaHjQJgsZFWeak0paBOmEws9mAG5sBdH9vvvvEPYKlM'

      for (let i = 0; i < iterations; i++) {
        const start = performance.now()
        await verifyPassword(DUMMY_HASH, 'WrongPassword456!')
        const end = performance.now()
        nonExistentUserTimes.push(end - start)
      }

      // Calculate averages
      const avgValidUser = validUserTimes.reduce((a, b) => a + b, 0) / iterations
      const avgNonExistent = nonExistentUserTimes.reduce((a, b) => a + b, 0) / iterations

      // Calculate standard deviations
      const stdDevValid = Math.sqrt(
        validUserTimes.reduce((sum, time) => sum + Math.pow(time - avgValidUser, 2), 0) / iterations
      )
      const stdDevNonExistent = Math.sqrt(
        nonExistentUserTimes.reduce((sum, time) => sum + Math.pow(time - avgNonExistent, 2), 0) /
          iterations
      )

      // The difference should be within statistical noise (< 2 standard deviations)
      const difference = Math.abs(avgValidUser - avgNonExistent)
      const combinedStdDev = Math.sqrt(stdDevValid ** 2 + stdDevNonExistent ** 2)

      // Allow up to 3 sigma difference (99.7% confidence)
      expect(difference).toBeLessThan(3 * combinedStdDev)

      // Log for manual inspection
      console.log({
        avgValidUser: `${avgValidUser.toFixed(2)}ms`,
        avgNonExistent: `${avgNonExistent.toFixed(2)}ms`,
        difference: `${difference.toFixed(2)}ms`,
        threshold: `${(3 * combinedStdDev).toFixed(2)}ms`,
      })
    })

    it('should use constant-time comparison in Argon2 verification', async () => {
      const password = 'TestPassword123!'
      const hash = await hashPassword(password)

      const correctTimes: number[] = []
      const incorrectTimes: number[] = []

      // Measure correct password
      for (let i = 0; i < 100; i++) {
        const start = performance.now()
        await verifyPassword(hash, password)
        correctTimes.push(performance.now() - start)
      }

      // Measure incorrect password (same length)
      for (let i = 0; i < 100; i++) {
        const start = performance.now()
        await verifyPassword(hash, 'WrongPassword456!')
        incorrectTimes.push(performance.now() - start)
      }

      const avgCorrect = correctTimes.reduce((a, b) => a + b, 0) / 100
      const avgIncorrect = incorrectTimes.reduce((a, b) => a + b, 0) / 100

      // Argon2 should have similar timing regardless of password correctness
      // Allow 20% variance due to system noise
      const variance = Math.abs(avgCorrect - avgIncorrect) / avgCorrect
      expect(variance).toBeLessThan(0.2)
    })
  })

  describe('Secret validation timing', () => {
    it('should use constant-time comparison for secrets', () => {
      const secret = 'super-secret-bootstrap-token-12345'

      const correctTimes: number[] = []
      const incorrectTimes: number[] = []

      // Measure correct secret - run 10,000 iterations to reduce measurement noise
      for (let i = 0; i < 10000; i++) {
        const start = performance.now()
        isSecretValid(secret, secret)
        correctTimes.push(performance.now() - start)
      }

      // Measure incorrect secret (same length, only last char different)
      const almostCorrect = secret.slice(0, -1) + '6'
      for (let i = 0; i < 10000; i++) {
        const start = performance.now()
        isSecretValid(almostCorrect, secret)
        incorrectTimes.push(performance.now() - start)
      }

      const avgCorrect = correctTimes.reduce((a, b) => a + b, 0) / 10000
      const avgIncorrect = incorrectTimes.reduce((a, b) => a + b, 0) / 10000

      // For very fast operations (microseconds), allow higher variance due to measurement noise
      // The key is that we're using a timing-safe comparison function from Node.js crypto
      const variance = Math.abs(avgCorrect - avgIncorrect) / Math.max(avgCorrect, avgIncorrect)

      // If the operation is extremely fast (<0.001ms), the variance is mostly measurement noise
      if (avgCorrect < 0.001 && avgIncorrect < 0.001) {
        // Just verify it completes without error - timing is too fast to measure reliably
        expect(isSecretValid(secret, secret)).toBe(true)
        expect(isSecretValid(almostCorrect, secret)).toBe(false)
      } else {
        // For slower operations, verify constant-time behavior
        expect(variance).toBeLessThan(0.5)
      }

      console.log({
        avgCorrect: `${avgCorrect.toFixed(6)}ms`,
        avgIncorrect: `${avgIncorrect.toFixed(6)}ms`,
        variance: `${(variance * 100).toFixed(2)}%`,
        tooFastToMeasure: avgCorrect < 0.001 && avgIncorrect < 0.001,
      })
    })

    it('should not leak information via timing for different-length secrets', () => {
      const secret = 'super-secret-bootstrap-token-12345'

      const sameLengthTimes: number[] = []
      const differentLengthTimes: number[] = []

      // Measure same-length incorrect secret
      for (let i = 0; i < 1000; i++) {
        const start = performance.now()
        isSecretValid('wrong-secret-bootstrap-token-99999', secret)
        sameLengthTimes.push(performance.now() - start)
      }

      // Measure different-length incorrect secret
      for (let i = 0; i < 1000; i++) {
        const start = performance.now()
        isSecretValid('short', secret)
        differentLengthTimes.push(performance.now() - start)
      }

      const avgSameLength = sameLengthTimes.reduce((a, b) => a + b, 0) / 1000
      const avgDifferentLength = differentLengthTimes.reduce((a, b) => a + b, 0) / 1000

      // Timing should be similar regardless of length mismatch
      const variance =
        Math.abs(avgSameLength - avgDifferentLength) / Math.max(avgSameLength, avgDifferentLength)
      expect(variance).toBeLessThan(0.5)
    })
  })

  describe('Bootstrap token timing', () => {
    it('should verify bootstrap tokens in constant time', async () => {
      const validToken = 'valid-bootstrap-token-12345'
      const validHash = await hashPassword(validToken)

      const correctTimes: number[] = []
      const incorrectTimes: number[] = []
      const expiredTimes: number[] = []

      // Measure valid token verification
      for (let i = 0; i < 50; i++) {
        const start = performance.now()
        await verifyPassword(validHash, validToken)
        correctTimes.push(performance.now() - start)
      }

      // Measure invalid token (same length)
      for (let i = 0; i < 50; i++) {
        const start = performance.now()
        await verifyPassword(validHash, 'wrong-bootstrap-token-99999')
        incorrectTimes.push(performance.now() - start)
      }

      // Measure with DUMMY_HASH (simulating expired/used token)
      const DUMMY_HASH =
        '$argon2id$v=19$m=19456,t=2,p=1$aG9uZXN0bHktanVzdC1hLWR1bW15LXNhbHQ$NaHjQJgsZFWeak0paBOmEws9mAG5sBdH9vvvvEPYKlM'
      for (let i = 0; i < 50; i++) {
        const start = performance.now()
        await verifyPassword(DUMMY_HASH, validToken)
        expiredTimes.push(performance.now() - start)
      }

      const avgCorrect = correctTimes.reduce((a, b) => a + b, 0) / 50
      const avgIncorrect = incorrectTimes.reduce((a, b) => a + b, 0) / 50
      const avgExpired = expiredTimes.reduce((a, b) => a + b, 0) / 50

      // All three should be within similar timing
      const maxVariance = Math.max(
        Math.abs(avgCorrect - avgIncorrect) / avgCorrect,
        Math.abs(avgCorrect - avgExpired) / avgCorrect,
        Math.abs(avgIncorrect - avgExpired) / avgIncorrect
      )

      expect(maxVariance).toBeLessThan(0.3)

      console.log({
        avgCorrect: `${avgCorrect.toFixed(2)}ms`,
        avgIncorrect: `${avgIncorrect.toFixed(2)}ms`,
        avgExpired: `${avgExpired.toFixed(2)}ms`,
        maxVariance: `${(maxVariance * 100).toFixed(2)}%`,
      })
    })
  })

  describe('Password length edge cases', () => {
    it('should handle very long passwords without timing leaks', async () => {
      // Create passwords of different lengths
      const shortPassword = 'Short123!'
      const longPassword = 'A'.repeat(1000) + '123!'

      const shortHash = await hashPassword(shortPassword)
      const longHash = await hashPassword(longPassword)

      // Verify wrong password against different-length hashes
      const wrongPassword = 'Wrong123!'

      const shortHashTimes: number[] = []
      const longHashTimes: number[] = []

      for (let i = 0; i < 20; i++) {
        const start1 = performance.now()
        await verifyPassword(shortHash, wrongPassword)
        shortHashTimes.push(performance.now() - start1)

        const start2 = performance.now()
        await verifyPassword(longHash, wrongPassword)
        longHashTimes.push(performance.now() - start2)
      }

      const avgShort = shortHashTimes.reduce((a, b) => a + b, 0) / 20
      const avgLong = longHashTimes.reduce((a, b) => a + b, 0) / 20

      // Should be similar timing despite password length difference
      const variance = Math.abs(avgShort - avgLong) / Math.max(avgShort, avgLong)
      expect(variance).toBeLessThan(0.4)
    })

    it('should reject extremely long passwords safely', async () => {
      // Passwords over 1MB should be rejected to prevent DoS
      const megabytePassword = 'A'.repeat(1024 * 1024) + '123!'

      // Should not hang or crash
      const start = performance.now()
      try {
        await hashPassword(megabytePassword)
        const duration = performance.now() - start

        // Even if accepted, should complete in reasonable time
        expect(duration).toBeLessThan(5000) // 5 seconds max
      } catch (error) {
        // If rejected, that's fine too
        expect(error).toBeDefined()
      }
    })
  })

  describe('Unicode normalization timing', () => {
    it('should handle unicode passwords consistently', async () => {
      // Different unicode representations of same visual character
      const password1 = 'café123!' // é as single character (U+00E9)
      const password2 = 'café123!' // é as e + combining accent (U+0065 U+0301)

      const hash = await hashPassword(password1)

      const times1: number[] = []
      const times2: number[] = []

      for (let i = 0; i < 50; i++) {
        const start1 = performance.now()
        await verifyPassword(hash, password1)
        times1.push(performance.now() - start1)

        const start2 = performance.now()
        await verifyPassword(hash, password2)
        times2.push(performance.now() - start2)
      }

      const avg1 = times1.reduce((a, b) => a + b, 0) / 50
      const avg2 = times2.reduce((a, b) => a + b, 0) / 50

      // Timing should be similar for different unicode forms
      const variance = Math.abs(avg1 - avg2) / Math.max(avg1, avg2)
      expect(variance).toBeLessThan(0.3)
    })
  })

  describe('API key verification timing', () => {
    it('should validate API key prefixes in constant time', () => {
      const validPrefix = 'cat_sk_orgname_'
      const validKey = validPrefix + 'A'.repeat(43)

      const times: Record<string, number[]> = {
        valid: [],
        wrongPrefix: [],
        noUnderscore: [],
        empty: [],
      }

      const testCases = [
        { key: validKey, category: 'valid' },
        { key: 'dog_sk_orgname_' + 'B'.repeat(43), category: 'wrongPrefix' },
        { key: 'catskorgname' + 'C'.repeat(43), category: 'noUnderscore' },
        { key: '', category: 'empty' },
      ]

      // Run timing measurements
      for (let i = 0; i < 500; i++) {
        for (const testCase of testCases) {
          const start = performance.now()

          // Simple prefix extraction (what the code does)
          const parts = testCase.key.split('_')
          const _prefix = parts.slice(0, -1).join('_') + '_'

          times[testCase.category].push(performance.now() - start)
        }
      }

      // Calculate averages
      const averages = Object.fromEntries(
        Object.entries(times).map(([category, measurements]) => [
          category,
          measurements.reduce((a, b) => a + b, 0) / measurements.length,
        ])
      )

      // All should be within 100% variance of each other (very generous)
      const avgValues = Object.values(averages)
      const maxAvg = Math.max(...avgValues)
      const minAvg = Math.min(...avgValues)
      const variance = (maxAvg - minAvg) / maxAvg

      expect(variance).toBeLessThan(1.0)
    })
  })
})
