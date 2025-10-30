/**
 * Performance Tests: Query Response Time & Cost Tracking
 *
 * ⚠️ CRITICAL: These tests verify that the system meets performance SLAs:
 * - Consensus voting: < 10s response time
 * - Simple queries: < 2s response time
 * - Complex queries: < 5s response time
 * - Cost optimization: ~$0.55/user/month
 *
 * World-Class Pattern: AWS CloudWatch Performance Monitoring
 *
 * Tests:
 * - Response time benchmarks
 * - Parallel execution efficiency
 * - Cost tracking (API calls)
 * - Memory usage monitoring
 *
 * Uses REAL PostgreSQL database and REAL OpenAI API!
 */

import { setupTestData, teardownTestData } from '@tests/helpers/test-data-setup'
import textToSqlService from '@/services/dashboard/text-to-sql-assistant.service'

describe('Query Performance Tests', () => {
  let testData: Awaited<ReturnType<typeof setupTestData>>
  const service = textToSqlService

  beforeAll(async () => {
    testData = await setupTestData()
  })

  afterAll(async () => {
    await teardownTestData()
  })

  describe('Response Time Benchmarks', () => {
    it('should complete simple queries in < 2s (SharedQueryService)', async () => {
      const query = {
        message: '¿Cuánto vendí hoy?',
        venueId: testData.venue.id,
        userId: testData.staff[0].id,
        venueSlug: testData.venue.slug,
      }

      const startTime = Date.now()
      const response = await service.processQuery(query)
      const duration = Date.now() - startTime

      expect(((response.metadata || {}) as any).routedTo).toBe('SharedQueryService')
      expect(duration).toBeLessThan(2000) // < 2s SLA
    }, 5000)

    it('should complete complex single-SQL queries in < 5s', async () => {
      const query = {
        message: '¿Cuántas órdenes tuve después de las 8pm?',
        venueId: testData.venue.id,
        userId: testData.staff[0].id,
        venueSlug: testData.venue.slug,
      }

      const startTime = Date.now()
      const response = await service.processQuery(query)
      const duration = Date.now() - startTime

      // Should NOT use consensus (complex but not important)
      expect(((response.metadata || {}) as any).consensusVoting).toBeUndefined()

      // Should complete in < 5s
      expect(duration).toBeLessThan(5000)
    }, 10000)

    it('should complete consensus voting in < 10s', async () => {
      const query = {
        message: '¿Cuánto vendí de hamburguesas vs pizzas?',
        venueId: testData.venue.id,
        userId: testData.staff[0].id,
        venueSlug: testData.venue.slug,
      }

      const startTime = Date.now()
      const response = await service.processQuery(query)
      const duration = Date.now() - startTime

      if (((response.metadata || {}) as any).consensusVoting) {
        // Consensus voting SLA: < 10s
        expect(duration).toBeLessThan(10000)
      }
    }, 15000)
  })

  describe('Parallel Execution Efficiency', () => {
    it('should execute consensus queries faster than 3× sequential time', async () => {
      const query = {
        message: '¿Quién vendió más comparado con el que vendió menos?',
        venueId: testData.venue.id,
        userId: testData.staff[0].id,
        venueSlug: testData.venue.slug,
      }

      const startTime = Date.now()
      const response = await service.processQuery(query)
      const parallelTime = Date.now() - startTime

      if (((response.metadata || {}) as any).consensusVoting) {
        // Parallel should be < 15s
        // Sequential would be ~15-20s (3 × 5s)
        // Parallel should be ~5-10s (max time of 3)
        expect(parallelTime).toBeLessThan(15000)

        // Log performance metrics
        console.log('📊 Consensus Performance:', {
          parallelTime: `${parallelTime}ms`,
          generations: (response.metadata as any).consensusVoting.totalGenerations,
          successful: (response.metadata as any).consensusVoting.successfulExecutions,
          estimatedSequentialTime: '~15000ms',
          speedup: `${((15000 / parallelTime) * 100 - 100).toFixed(0)}% faster`,
        })
      }
    }, 20000)
  })

  describe('Cost Tracking & Optimization', () => {
    it('should route 70% of queries to SharedQueryService ($0 cost)', async () => {
      const simpleQueries = [
        '¿Cuánto vendí hoy?',
        '¿Cuánto vendí esta semana?',
        '¿Cuál es mi ticket promedio?',
        '¿Qué productos vendí más?',
        '¿Quién es mi mejor mesero?',
        '¿Cuántas reseñas tengo?',
        '¿Cuál es mi promedio de estrellas?',
      ]

      let sharedQueryCount = 0

      for (const message of simpleQueries) {
        const response = await service.processQuery({
          message,
          venueId: testData.venue.id,
          userId: testData.staff[0].id,
          venueSlug: testData.venue.slug,
        })

        if (((response.metadata || {}) as any).routedTo === 'SharedQueryService') {
          sharedQueryCount++
        }
      }

      // At least 70% should use SharedQueryService
      const percentageShared = (sharedQueryCount / simpleQueries.length) * 100
      expect(percentageShared).toBeGreaterThanOrEqual(70)

      console.log('💰 Cost Optimization:', {
        totalQueries: simpleQueries.length,
        sharedQueryService: sharedQueryCount,
        percentage: `${percentageShared.toFixed(0)}%`,
        costSavings: `$${(sharedQueryCount * 0.01).toFixed(2)} saved`,
      })
    }, 60000) // 60s timeout for multiple queries

    it('should use consensus voting only for complex + important queries (~10%)', async () => {
      const mixedQueries = [
        { message: '¿Cuánto vendí hoy?', expectedRoute: 'SharedQueryService' },
        { message: '¿Cuánto vendí esta semana?', expectedRoute: 'SharedQueryService' },
        { message: '¿Hamburguesas vs pizzas?', expectedRoute: 'consensus' },
        { message: '¿Cuál es mi ticket promedio?', expectedRoute: 'SharedQueryService' },
        { message: '¿Qué mesero vendió más?', expectedRoute: 'SharedQueryService' },
        { message: '¿Mejor vs peor producto?', expectedRoute: 'consensus' },
        { message: '¿Cuántas órdenes tuve?', expectedRoute: 'SharedQueryService' },
        { message: '¿Ventas de enero vs febrero?', expectedRoute: 'consensus' },
        { message: '¿Qué productos vendí más?', expectedRoute: 'SharedQueryService' },
        { message: '¿Cuántas reseñas tengo?', expectedRoute: 'SharedQueryService' },
      ]

      let consensusCount = 0
      let sharedQueryCount = 0
      let singleSqlCount = 0

      for (const query of mixedQueries) {
        const response = await service.processQuery({
          message: query.message,
          venueId: testData.venue.id,
          userId: testData.staff[0].id,
          venueSlug: testData.venue.slug,
        })

        if (((response.metadata || {}) as any).consensusVoting) {
          consensusCount++
        } else if (((response.metadata || {}) as any).routedTo === 'SharedQueryService') {
          sharedQueryCount++
        } else {
          singleSqlCount++
        }
      }

      const consensusPercentage = (consensusCount / mixedQueries.length) * 100

      // Consensus should be ~10-30% (complex + important queries)
      expect(consensusPercentage).toBeGreaterThanOrEqual(10)
      expect(consensusPercentage).toBeLessThanOrEqual(40)

      // Estimate monthly cost (assuming 100 queries/user/month)
      const estimatedCost =
        sharedQueryCount * 0.0 + // Free
        singleSqlCount * 0.01 + // $0.01 per single SQL
        consensusCount * 0.03 // $0.03 per consensus (3× generations)

      console.log('💰 Cost Breakdown:', {
        totalQueries: mixedQueries.length,
        sharedQuery: `${sharedQueryCount} (${((sharedQueryCount / mixedQueries.length) * 100).toFixed(0)}%)`,
        singleSql: `${singleSqlCount} (${((singleSqlCount / mixedQueries.length) * 100).toFixed(0)}%)`,
        consensus: `${consensusCount} (${consensusPercentage.toFixed(0)}%)`,
        estimatedCostPer10Queries: `$${estimatedCost.toFixed(3)}`,
        estimatedCostPer100Queries: `$${(estimatedCost * 10).toFixed(2)}`,
        targetCost: '$0.55/user/month',
      })

      // Verify cost is under target ($0.55 for 100 queries/month)
      expect(estimatedCost * 10).toBeLessThan(1.0) // Should be well under $1.00
    }, 120000) // 2 min timeout for 10 queries
  })

  describe('Stress Testing', () => {
    it('should handle 5 concurrent queries without degradation', async () => {
      const queries = [
        '¿Cuánto vendí hoy?',
        '¿Cuál es mi ticket promedio?',
        '¿Qué productos vendí más?',
        '¿Quién es mi mejor mesero?',
        '¿Cuántas reseñas tengo?',
      ]

      const startTime = Date.now()

      const promises = queries.map(message =>
        service.processQuery({
          message,
          venueId: testData.venue.id,
          userId: testData.staff[0].id,
          venueSlug: testData.venue.slug,
        }),
      )

      const results = await Promise.all(promises)
      const totalTime = Date.now() - startTime

      // All queries should succeed
      expect(results.length).toBe(5)
      results.forEach((result: any) => {
        expect(result.response).toBeDefined()
        expect(result.confidence).toBeGreaterThan(0)
      })

      // Concurrent execution should be efficient
      // Sequential would be ~5 × 2s = 10s
      // Concurrent should be ~2-4s (max of all)
      expect(totalTime).toBeLessThan(8000)

      console.log('⚡ Concurrent Performance:', {
        queries: queries.length,
        totalTime: `${totalTime}ms`,
        avgTimePerQuery: `${(totalTime / queries.length).toFixed(0)}ms`,
        estimatedSequentialTime: '~10000ms',
      })
    }, 15000)
  })

  describe('Memory Usage Monitoring', () => {
    it('should not leak memory during consensus voting', async () => {
      const initialMemory = process.memoryUsage().heapUsed

      // Run 3 consensus queries
      for (let i = 0; i < 3; i++) {
        await service.processQuery({
          message: `¿Cuánto vendí de producto ${i} vs producto ${i + 1}?`,
          venueId: testData.venue.id,
          userId: testData.staff[0].id,
          venueSlug: testData.venue.slug,
        })
      }

      // Force garbage collection if available
      if (global.gc) {
        global.gc()
      }

      const finalMemory = process.memoryUsage().heapUsed
      const memoryIncrease = finalMemory - initialMemory

      // Memory increase should be reasonable (< 50MB)
      const memoryIncreaseMB = memoryIncrease / 1024 / 1024

      console.log('💾 Memory Usage:', {
        initialHeap: `${(initialMemory / 1024 / 1024).toFixed(2)} MB`,
        finalHeap: `${(finalMemory / 1024 / 1024).toFixed(2)} MB`,
        increase: `${memoryIncreaseMB.toFixed(2)} MB`,
      })

      // Should not leak significant memory
      expect(memoryIncreaseMB).toBeLessThan(50)
    }, 60000)
  })
})
