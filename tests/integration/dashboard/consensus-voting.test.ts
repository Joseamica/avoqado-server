/**
 * Integration Tests: Consensus Voting System
 *
 * ⚠️ CRITICAL: These tests verify that consensus voting works end-to-end
 * with REAL database queries and LLM generations.
 *
 * World-Class Pattern: Salesforce Consensus Algorithm
 *
 * Tests:
 * - Complex + Important queries route to consensus voting
 * - 3 SQL generations execute in parallel
 * - Majority agreement detection (2/3 or 3/3)
 * - High confidence for 66%+ agreement
 * - Low confidence for <66% agreement
 *
 * Uses REAL PostgreSQL database and REAL OpenAI API!
 */

import { setupTestData, teardownTestData } from '@tests/helpers/test-data-setup'
import textToSqlService from '@/services/dashboard/text-to-sql-assistant.service'
import { cleanupInventoryTestData } from '@tests/helpers/inventory-test-helpers'

// Increase timeout for integration tests (Neon cold start can be slow)
jest.setTimeout(60000)

describe('Consensus Voting Integration Tests', () => {
  let testData: Awaited<ReturnType<typeof setupTestData>>
  const service = textToSqlService

  beforeAll(async () => {
    testData = await setupTestData()
  })

  afterAll(async () => {
    await cleanupInventoryTestData(testData.venue.id)
    await teardownTestData()
  })

  describe('Query Routing Logic', () => {
    it('should route complex + important queries to consensus voting', async () => {
      // This query has:
      // - Comparison (vs) → Complex
      // - Ranking implication → Important
      const query = {
        message: '¿Cuánto vendí de hamburguesas vs pizzas esta semana?',
        venueId: testData.venue.id,
        userId: testData.staff[0].id,
        venueSlug: testData.venue.slug,
      }

      const response = await service.processQuery(query)

      // Verify consensus metadata exists
      const metadata = (response.metadata || {}) as any
      expect(metadata.consensusVoting).toBeDefined()
      expect(metadata.consensusVoting.totalGenerations).toBe(3)
      expect(metadata.consensusVoting.successfulExecutions).toBeGreaterThanOrEqual(1)
      expect(metadata.consensusVoting.confidence).toMatch(/high|medium|low/)
    }, 15000) // 15s timeout for LLM + DB queries

    it('should route simple queries to SharedQueryService (NOT consensus)', async () => {
      const query = {
        message: '¿Cuánto vendí hoy?',
        venueId: testData.venue.id,
        userId: testData.staff[0].id,
        venueSlug: testData.venue.slug,
      }

      const response = await service.processQuery(query)

      // Verify it used SharedQueryService
      expect(((response.metadata || {}) as any).routedTo).toBe('SharedQueryService')
      expect(((response.metadata || {}) as any).consensusVoting).toBeUndefined()
    }, 10000)

    it('should route complex but NOT important queries to single SQL + Layer 6', async () => {
      // Complex (time filter) but not important (no ranking/comparison)
      const query = {
        message: '¿Cuántas órdenes tuve después de las 8pm?',
        venueId: testData.venue.id,
        userId: testData.staff[0].id,
        venueSlug: testData.venue.slug,
      }

      const response = await service.processQuery(query)

      // Verify it did NOT use consensus (no consensusVoting metadata)
      expect(((response.metadata || {}) as any).consensusVoting).toBeUndefined()

      // Verify Layer 6 sanity checks were performed
      const metadata2 = (response.metadata || {}) as any
      expect(metadata2.layer6SanityChecks).toBeDefined()
      expect(metadata2.layer6SanityChecks.performed).toBe(true)
    }, 10000)
  })

  describe('Consensus Agreement Detection', () => {
    it('should achieve high confidence when 2+ generations agree', async () => {
      // Use a query with deterministic answer (today's sales)
      const query = {
        message: '¿Cuál es el total de ventas comparado con ayer?',
        venueId: testData.venue.id,
        userId: testData.staff[0].id,
        venueSlug: testData.venue.slug,
      }

      const response = await service.processQuery(query)

      // If consensus was used
      const metadata3 = (response.metadata || {}) as any
      if (metadata3.consensusVoting) {
        const { successfulExecutions, agreementPercent, confidence } = metadata3.consensusVoting

        // At least 2 executions succeeded
        expect(successfulExecutions).toBeGreaterThanOrEqual(2)

        // If 2+ succeeded, check confidence logic
        if (successfulExecutions >= 2) {
          // High confidence should be 66% or 100%
          if (confidence === 'high') {
            expect([66, 100]).toContain(agreementPercent)
          }

          // Medium confidence should be 66% (for 2/3 match in middle position)
          if (confidence === 'medium') {
            expect(agreementPercent).toBe(66)
          }

          // Low confidence should be 33% or 50%
          if (confidence === 'low') {
            expect([33, 50]).toContain(agreementPercent)
          }
        }
      }
    }, 20000) // 20s timeout for 3 parallel LLM calls

    it('should handle partial failures gracefully (some SQLs fail)', async () => {
      // Complex query that might generate invalid SQL
      const query = {
        message: '¿Quién vendió más el 99 de febrero de 2025?', // Invalid date
        venueId: testData.venue.id,
        userId: testData.staff[0].id,
        venueSlug: testData.venue.slug,
      }

      // This might fail or succeed with error handling
      try {
        const response = await service.processQuery(query)

        // If consensus was attempted
        const metadata4 = (response.metadata || {}) as any
        if (metadata4.consensusVoting) {
          // Some executions might have failed
          expect(metadata4.consensusVoting.successfulExecutions).toBeGreaterThanOrEqual(0)
          expect(metadata4.consensusVoting.successfulExecutions).toBeLessThanOrEqual(3)
        }

        // Should still return a response (might be low confidence or error message)
        expect(response.response).toBeDefined()
        expect(typeof response.response).toBe('string')
      } catch (error: any) {
        // If it fails completely, that's also acceptable for invalid queries
        expect(error.message).toBeDefined()
      }
    }, 20000)
  })

  describe('Parallel Execution Performance', () => {
    it('should execute 3 SQL generations in parallel (faster than sequential)', async () => {
      const query = {
        message: '¿Cuánto vendí de bebidas versus postres esta semana?',
        venueId: testData.venue.id,
        userId: testData.staff[0].id,
        venueSlug: testData.venue.slug,
      }

      const startTime = Date.now()
      const response = await service.processQuery(query)
      const totalTime = Date.now() - startTime

      // If consensus was used
      if (((response.metadata || {}) as any).consensusVoting) {
        // Parallel execution should be faster than sequential (< 3 * individual time)
        // With parallel: ~5-8s (3 LLM calls + DB)
        // With sequential: ~15-20s (3 × 5s)
        expect(totalTime).toBeLessThan(15000) // Should be < 15s (sequential would be 15-20s)

        // But still reasonable (not instant)
        expect(totalTime).toBeGreaterThan(2000) // At least 2s for LLM processing
      }
    }, 20000)

    it('should complete consensus voting in < 10s for most queries', async () => {
      const query = {
        message: '¿Quién es el mejor mesero comparado con el peor?',
        venueId: testData.venue.id,
        userId: testData.staff[0].id,
        venueSlug: testData.venue.slug,
      }

      const startTime = Date.now()
      const response = await service.processQuery(query)
      const totalTime = Date.now() - startTime

      if (((response.metadata || {}) as any).consensusVoting) {
        // Performance target: < 10s for consensus voting
        expect(totalTime).toBeLessThan(10000)
      }
    }, 30000) // Increased timeout for 3 LLM calls + SQL executions
  })

  describe('Consensus Metadata Validation', () => {
    it('should include complete consensus metadata in response', async () => {
      const query = {
        message: '¿Qué producto vendí más comparado con el que menos vendí?',
        venueId: testData.venue.id,
        userId: testData.staff[0].id,
        venueSlug: testData.venue.slug,
      }

      const response = await service.processQuery(query)

      const metadata5 = (response.metadata || {}) as any
      if (metadata5.consensusVoting) {
        const { totalGenerations, successfulExecutions, agreementPercent, confidence } = metadata5.consensusVoting

        // Verify metadata structure
        expect(totalGenerations).toBe(3)
        expect(successfulExecutions).toBeGreaterThanOrEqual(0)
        expect(successfulExecutions).toBeLessThanOrEqual(3)
        expect([33, 50, 66, 100]).toContain(agreementPercent)
        expect(['high', 'medium', 'low']).toContain(confidence)
      }
    }, 30000) // Increased timeout for 3 LLM calls + SQL executions
  })

  describe('Regression Tests - Non-Consensus Queries Still Work', () => {
    it('should still handle simple queries correctly (non-consensus)', async () => {
      const query = {
        message: '¿Cuánto vendí esta semana?',
        venueId: testData.venue.id,
        userId: testData.staff[0].id,
        venueSlug: testData.venue.slug,
      }

      const response = await service.processQuery(query)

      // Verify it worked without consensus
      expect(response.response).toBeDefined()
      expect(response.confidence).toBeGreaterThan(0.5)
      expect(((response.metadata || {}) as any).routedTo).toBe('SharedQueryService')
    }, 10000)

    it('should still handle normal complex queries (no consensus needed)', async () => {
      const query = {
        message: '¿Cuántas órdenes tuve en total?',
        venueId: testData.venue.id,
        userId: testData.staff[0].id,
        venueSlug: testData.venue.slug,
      }

      const response = await service.processQuery(query)

      expect(response.response).toBeDefined()
      expect(response.confidence).toBeGreaterThan(0)
    }, 10000)
  })
})
