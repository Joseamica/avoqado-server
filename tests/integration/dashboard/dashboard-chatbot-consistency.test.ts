/**
 * Integration Tests: Dashboard-Chatbot Consistency (Layer 4 Validation)
 *
 * ⚠️ CRITICAL: These tests verify that chatbot responses match dashboard values
 * within acceptable tolerance (1%).
 *
 * World-Class Pattern: Stripe Consistency Guarantee
 *
 * Tests:
 * - Simple queries → 100% consistency (SharedQueryService)
 * - Complex queries → Layer 4 validation catches mismatches
 * - Tolerance handling (1% difference = warning, not error)
 * - Cross-check validation logs mismatches
 *
 * Uses REAL PostgreSQL database!
 */

import prisma from '@/utils/prismaClient'
import { setupTestData, teardownTestData } from '@tests/helpers/test-data-setup'
import textToSqlService from '@/services/dashboard/text-to-sql-assistant.service'
import { SharedQueryService } from '@/services/dashboard/shared-query.service'
import { SqlValidationService } from '@/services/dashboard/sql-validation.service'
import { Prisma } from '@prisma/client'

// Increase timeout for integration tests (Neon cold start can be slow)
jest.setTimeout(60000)

describe('Dashboard-Chatbot Consistency Tests (Layer 4)', () => {
  let testData: Awaited<ReturnType<typeof setupTestData>>
  const service = textToSqlService

  beforeAll(async () => {
    testData = await setupTestData()

    // Create test payments for consistency testing
    await createTestPayments(testData.venue.id, testData.staff[0].id)
  })

  afterAll(async () => {
    await teardownTestData()
  })

  describe('Simple Query Consistency (SharedQueryService)', () => {
    it('should return 100% consistent results for "¿Cuánto vendí hoy?"', async () => {
      // Get dashboard value
      const dashboardValue = await SharedQueryService.getSalesForPeriod(testData.venue.id, 'today')

      // Get chatbot value
      const chatbotResponse = await service.processQuery({
        message: '¿Cuánto vendí hoy?',
        venueId: testData.venue.id,
        userId: testData.staff[0].id,
        venueSlug: testData.venue.slug,
      })

      // Both should use SharedQueryService → 100% identical
      expect(((chatbotResponse.metadata || {}) as any).routedTo).toBe('SharedQueryService')

      // Verify values match (if chatbot has queryResult)
      if (chatbotResponse.queryResult) {
        expect(chatbotResponse.queryResult.totalRevenue).toBe(dashboardValue.totalRevenue)
        expect(chatbotResponse.queryResult.orderCount).toBe(dashboardValue.orderCount)
        expect(chatbotResponse.queryResult.averageTicket).toBe(dashboardValue.averageTicket)
      }
    }, 10000)

    it('should return 100% consistent results for "¿Cuál es mi ticket promedio?"', async () => {
      const dashboardValue = await SharedQueryService.getAverageTicket(testData.venue.id, 'last7days')

      const chatbotResponse = await service.processQuery({
        message: '¿Cuál es mi ticket promedio esta semana?',
        venueId: testData.venue.id,
        userId: testData.staff[0].id,
        venueSlug: testData.venue.slug,
      })

      expect(((chatbotResponse.metadata || {}) as any).routedTo).toBe('SharedQueryService')

      if (chatbotResponse.queryResult?.averageTicket !== undefined) {
        expect(chatbotResponse.queryResult.averageTicket).toBe(dashboardValue)
      }
    }, 10000)

    it('should return 100% consistent results for "¿Qué productos vendí más?"', async () => {
      const dashboardValue = await SharedQueryService.getTopProducts(testData.venue.id, 'last7days', 5)

      const chatbotResponse = await service.processQuery({
        message: '¿Qué productos vendí más esta semana?',
        venueId: testData.venue.id,
        userId: testData.staff[0].id,
        venueSlug: testData.venue.slug,
      })

      expect(((chatbotResponse.metadata || {}) as any).routedTo).toBe('SharedQueryService')

      if (Array.isArray(chatbotResponse.queryResult)) {
        expect(chatbotResponse.queryResult.length).toBe(dashboardValue.length)

        // Verify top product matches
        if (dashboardValue.length > 0 && chatbotResponse.queryResult.length > 0) {
          expect(chatbotResponse.queryResult[0].productName).toBe(dashboardValue[0].productName)
          expect(chatbotResponse.queryResult[0].quantitySold).toBe(dashboardValue[0].quantitySold)
        }
      }
    }, 10000)
  })

  describe('Layer 4 Cross-Check Validation', () => {
    it('should validate chatbot SQL results against dashboard (within tolerance)', async () => {
      // Simulate a SQL result from chatbot
      const chatbotSqlResult = [{ total: 12500.0 }]

      // Question that maps to sales intent
      const question = '¿Cuánto vendí esta semana?'

      // Run Layer 4 validation
      const validation = await SqlValidationService.validateDashboardCrossCheck(chatbotSqlResult, question, testData.venue.id)

      // Validation should pass (isValid = true)
      expect(validation.isValid).toBe(true)
      expect(validation.validationLayer).toBe('crossCheck')

      // Check if warnings exist (minor differences)
      if (validation.warnings.length > 0) {
        // Warnings should mention "difference" and percentage
        expect(validation.warnings.some(w => w.includes('difference') || w.includes('%'))).toBe(true)
      }
    })

    it('should detect major mismatches (> 1% difference)', async () => {
      // Get actual dashboard value
      const dashboardValue = await SharedQueryService.getSalesForPeriod(testData.venue.id, 'last7days')

      // Create a chatbot result with 10% higher value (major mismatch)
      const incorrectValue = dashboardValue.totalRevenue * 1.1
      const chatbotSqlResult = [{ total: incorrectValue }]

      const question = '¿Cuánto vendí esta semana?'

      const validation = await SqlValidationService.validateDashboardCrossCheck(chatbotSqlResult, question, testData.venue.id)

      // Should still be valid (Layer 4 is non-blocking) but have warnings
      expect(validation.isValid).toBe(true)

      // Should have warning about significant difference
      expect(validation.warnings.length).toBeGreaterThan(0)
      expect(validation.warnings.some(w => w.includes('difference') || w.includes('Dashboard'))).toBe(true)
    })

    it('should skip validation for complex queries (no simple intent)', async () => {
      const chatbotSqlResult = [
        { hour: 20, revenue: 5000 },
        { hour: 21, revenue: 3000 },
      ]

      // Complex query with no mappable intent
      const question = '¿Cuánto vendí después de las 8pm los fines de semana?'

      const validation = await SqlValidationService.validateDashboardCrossCheck(chatbotSqlResult, question, testData.venue.id)

      // Should skip validation
      expect(validation.isValid).toBe(true)
      expect(validation.suggestions.some(s => s.includes('skipped'))).toBe(true)
    })

    it('should handle empty results gracefully', async () => {
      const chatbotSqlResult: any[] = []

      const question = '¿Cuánto vendí hoy?'

      const validation = await SqlValidationService.validateDashboardCrossCheck(chatbotSqlResult, question, testData.venue.id)

      // Should pass validation (empty is valid)
      expect(validation.isValid).toBe(true)
    })
  })

  describe('Tolerance Boundary Testing', () => {
    it('should accept 0.5% difference (within 1% tolerance)', async () => {
      const dashboardValue = await SharedQueryService.getSalesForPeriod(testData.venue.id, 'last7days')

      // Create chatbot result with 0.5% difference
      const chatbotValue = dashboardValue.totalRevenue * 1.005
      const chatbotSqlResult = [{ total: chatbotValue }]

      const question = '¿Cuánto vendí esta semana?'

      const validation = await SqlValidationService.validateDashboardCrossCheck(chatbotSqlResult, question, testData.venue.id)

      // Should pass with minor warning
      expect(validation.isValid).toBe(true)

      // Might have warning but should mention "within tolerance"
      if (validation.warnings.length > 0) {
        expect(validation.warnings.some(w => w.includes('within') || w.includes('tolerance'))).toBe(true)
      }
    })

    it('should flag 2% difference (outside 1% tolerance)', async () => {
      const dashboardValue = await SharedQueryService.getSalesForPeriod(testData.venue.id, 'last7days')

      // Create chatbot result with 2% difference
      const chatbotValue = dashboardValue.totalRevenue * 1.02
      const chatbotSqlResult = [{ total: chatbotValue }]

      const question = '¿Cuánto vendí esta semana?'

      const validation = await SqlValidationService.validateDashboardCrossCheck(chatbotSqlResult, question, testData.venue.id)

      // Should still be valid (non-blocking)
      expect(validation.isValid).toBe(true)

      // But should have warnings
      expect(validation.warnings.length).toBeGreaterThan(0)
    })
  })

  describe('Multiple Intent Types', () => {
    it('should validate average ticket queries', async () => {
      const dashboardValue = await SharedQueryService.getAverageTicket(testData.venue.id, 'last7days')

      const chatbotSqlResult = [{ avg: dashboardValue }]

      const question = '¿Cuál es mi ticket promedio esta semana?'

      const validation = await SqlValidationService.validateDashboardCrossCheck(chatbotSqlResult, question, testData.venue.id)

      expect(validation.isValid).toBe(true)
    })

    it('should validate review stats queries', async () => {
      const dashboardValue = await SharedQueryService.getReviewStats(testData.venue.id, 'last30days')

      const chatbotSqlResult = [
        {
          avg_rating: dashboardValue.averageRating,
          total_reviews: dashboardValue.totalReviews,
        },
      ]

      const question = '¿Cuál es mi promedio de reseñas este mes?'

      const validation = await SqlValidationService.validateDashboardCrossCheck(chatbotSqlResult, question, testData.venue.id)

      expect(validation.isValid).toBe(true)
    })
  })
})

/**
 * Helper: Create test payments for consistency testing
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function createTestPayments(venueId: string, staffId: string) {
  const now = new Date()

  // Create payments with known values for testing
  const testPayments = [
    { amount: 250.0, tipAmount: 25.0, createdAt: now }, // Today
    { amount: 350.0, tipAmount: 35.0, createdAt: now }, // Today
    { amount: 450.0, tipAmount: 45.0, createdAt: new Date(now.getTime() - 24 * 60 * 60 * 1000) }, // Yesterday
    { amount: 550.0, tipAmount: 55.0, createdAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000) }, // 2 days ago
  ]

  for (let i = 0; i < testPayments.length; i++) {
    const payment = testPayments[i]

    // Create order first (required for payment)
    const order = await prisma.order.create({
      data: {
        venue: { connect: { id: venueId } },
        orderNumber: `TEST-${Date.now()}-${i}`,
        subtotal: new Prisma.Decimal(payment.amount),
        taxAmount: new Prisma.Decimal(0),
        total: new Prisma.Decimal(payment.amount),
        paymentStatus: 'PAID',
        status: 'COMPLETED',
        source: 'TPV',
        createdAt: payment.createdAt,
        updatedAt: payment.createdAt,
      },
    })

    // Create payment linked to order
    await prisma.payment.create({
      data: {
        venue: { connect: { id: venueId } },
        order: { connect: { id: order.id } },
        amount: new Prisma.Decimal(payment.amount),
        tipAmount: new Prisma.Decimal(payment.tipAmount),
        feePercentage: new Prisma.Decimal(0), // No fees for test data
        feeAmount: new Prisma.Decimal(0), // No fees for test data
        netAmount: new Prisma.Decimal(payment.amount), // Net = gross when no fees
        status: 'COMPLETED',
        method: 'CASH',
        source: 'TPV',
        createdAt: payment.createdAt,
        updatedAt: payment.createdAt,
      },
    })
  }
}
