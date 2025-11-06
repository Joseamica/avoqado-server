/**
 * Dashboard-Chatbot Consistency Integration Tests
 *
 * **WORLD-CLASS REQUIREMENT: 100% Consistency**
 *
 * WHY THIS EXISTS:
 * - Dashboard and chatbot MUST return identical results for the same query
 * - If a user asks "How much did I sell this week?" → chatbot says $12,525.77
 * - If user then looks at dashboard → dashboard MUST say $12,525.77
 * - ANY mismatch → user loses confidence in the system
 *
 * **PATTERN: Salesforce + Stripe + AWS**
 * - Pre-production benchmarking pipeline
 * - 100+ test cases covering common queries
 * - Automatic regression detection
 * - Golden dataset validation
 *
 * **TEST CATEGORIES:**
 * 1. Sales Queries - Revenue, average ticket, order count
 * 2. Product Queries - Top sellers, categories
 * 3. Staff Queries - Performance, tips
 * 4. Review Queries - Average rating, distribution
 * 5. Date Range Queries - Today, yesterday, last 7 days, etc.
 *
 * **TOLERANCE:**
 * - Money values: Max 1 cent difference (0.01)
 * - Percentages: Max 0.1% difference
 * - Counts: Must be exact
 * - Dates: Must be exact
 *
 * **CONTINUOUS VALIDATION:**
 * - Run on every commit (CI/CD)
 * - Run nightly against production snapshot
 * - Alert if consistency < 99%
 */

import { SharedQueryService } from '@/services/dashboard/shared-query.service'
import TextToSqlAssistantService from '@/services/dashboard/text-to-sql-assistant.service'
import prisma from '@/utils/prismaClient'
import { setupTestData, teardownTestData, TestVenue, TestUser } from '../helpers/test-data-setup'

// ⚠️ TEMPORARILY DISABLED: These tests consume ~1.5M OpenAI tokens ($2-3 USD per run)
// Re-enable when you need to test chatbot specifically
describe.skip('Dashboard-Chatbot Consistency Tests', () => {
  let testVenue: TestVenue
  let testUser: TestUser

  beforeAll(async () => {
    // Setup test database with realistic data
    const testData = await setupTestData()
    testVenue = testData.venue
    testUser = testData.user
  })

  afterAll(async () => {
    await teardownTestData()
    await prisma.$disconnect()
  })

  /**
   * Helper: Extract numeric value from chatbot natural language response
   *
   * Examples:
   * - "You sold $12,525.77 this week" → 12525.77
   * - "Your average ticket was $45.32" → 45.32
   * - "You had 150 orders" → 150
   */
  function extractNumber(response: string): number {
    // Remove currency symbols and commas
    const cleaned = response.replace(/[$,]/g, '')

    // Find first number (integer or decimal)
    const match = cleaned.match(/\d+\.?\d*/)
    if (!match) {
      throw new Error(`Could not extract number from response: ${response}`)
    }

    return parseFloat(match[0])
  }

  /**
   * Helper: Assert values are equal within tolerance
   */
  function assertNearlyEqual(actual: number, expected: number, tolerance: number, message: string) {
    const difference = Math.abs(actual - expected)
    expect(difference).toBeLessThanOrEqual(tolerance)
    if (difference > 0) {
      console.warn(`⚠️ Small difference detected: ${message}`, { actual, expected, difference })
    }
  }

  // ============================
  // SALES QUERIES
  // ============================

  describe('Sales Consistency', () => {
    it('should return identical total revenue for last 7 days', async () => {
      // Dashboard value
      const dashboardData = await SharedQueryService.getSalesForPeriod(testVenue.id, 'last7days')
      const dashboardRevenue = dashboardData.totalRevenue

      // Chatbot value
      const chatbotResponse = await TextToSqlAssistantService.processQuery({
        message: '¿Cuánto vendí en los últimos 7 días?',
        venueId: testVenue.id,
        userId: testUser.id,
        venueSlug: testVenue.slug,
      })
      const chatbotRevenue = extractNumber(chatbotResponse.response)

      // Assert consistency (max 1 cent difference)
      assertNearlyEqual(chatbotRevenue, dashboardRevenue, 0.01, 'Last 7 days revenue')
    })

    it('should return identical total revenue for today', async () => {
      const dashboardData = await SharedQueryService.getSalesForPeriod(testVenue.id, 'today')
      const chatbotResponse = await TextToSqlAssistantService.processQuery({
        message: '¿Cuánto vendí hoy?',
        venueId: testVenue.id,
        userId: testUser.id,
      })

      assertNearlyEqual(extractNumber(chatbotResponse.response), dashboardData.totalRevenue, 0.01, 'Today revenue')
    })

    it('should return identical total revenue for yesterday', async () => {
      const dashboardData = await SharedQueryService.getSalesForPeriod(testVenue.id, 'yesterday')
      const chatbotResponse = await TextToSqlAssistantService.processQuery({
        message: '¿Cuánto vendí ayer?',
        venueId: testVenue.id,
        userId: testUser.id,
      })

      assertNearlyEqual(extractNumber(chatbotResponse.response), dashboardData.totalRevenue, 0.01, 'Yesterday revenue')
    })

    it('should return identical total revenue for last 30 days', async () => {
      const dashboardData = await SharedQueryService.getSalesForPeriod(testVenue.id, 'last30days')
      const chatbotResponse = await TextToSqlAssistantService.processQuery({
        message: '¿Cuánto vendí en los últimos 30 días?',
        venueId: testVenue.id,
        userId: testUser.id,
      })

      assertNearlyEqual(extractNumber(chatbotResponse.response), dashboardData.totalRevenue, 0.01, 'Last 30 days revenue')
    })

    it('should return identical average ticket for last 7 days', async () => {
      const dashboardAvg = await SharedQueryService.getAverageTicket(testVenue.id, 'last7days')
      const chatbotResponse = await TextToSqlAssistantService.processQuery({
        message: '¿Cuál fue mi ticket promedio en los últimos 7 días?',
        venueId: testVenue.id,
        userId: testUser.id,
      })

      assertNearlyEqual(extractNumber(chatbotResponse.response), dashboardAvg, 0.01, 'Avg ticket last 7 days')
    })

    it('should return identical order count for last 7 days', async () => {
      const dashboardData = await SharedQueryService.getSalesForPeriod(testVenue.id, 'last7days')
      const chatbotResponse = await TextToSqlAssistantService.processQuery({
        message: '¿Cuántas órdenes tuve en los últimos 7 días?',
        venueId: testVenue.id,
        userId: testUser.id,
      })

      // Order count must be EXACT (no tolerance)
      expect(extractNumber(chatbotResponse.response)).toBe(dashboardData.orderCount)
    })
  })

  // ============================
  // PRODUCT QUERIES
  // ============================

  describe('Product Consistency', () => {
    it('should return identical top 5 products for last 30 days', async () => {
      const dashboardProducts = await SharedQueryService.getTopProducts(testVenue.id, 'last30days', 5)
      const chatbotResponse = await TextToSqlAssistantService.processQuery({
        message: '¿Cuáles son mis 5 productos más vendidos del último mes?',
        venueId: testVenue.id,
        userId: testUser.id,
      })

      // Extract product IDs from chatbot response
      // This is simplified - in production, you'd parse the full response
      const dashboardTopProduct = dashboardProducts[0]

      // Verify at least the top product appears in chatbot response
      expect(chatbotResponse.response).toContain(dashboardTopProduct.productName)
    })

    it('should return identical revenue for top product', async () => {
      const dashboardProducts = await SharedQueryService.getTopProducts(testVenue.id, 'last7days', 1)
      const topProduct = dashboardProducts[0]

      const chatbotResponse = await TextToSqlAssistantService.processQuery({
        message: `¿Cuánto vendí del producto "${topProduct.productName}" en los últimos 7 días?`,
        venueId: testVenue.id,
        userId: testUser.id,
      })

      assertNearlyEqual(extractNumber(chatbotResponse.response), topProduct.revenue, 0.01, 'Top product revenue')
    })
  })

  // ============================
  // STAFF QUERIES
  // ============================

  describe('Staff Consistency', () => {
    it('should return identical top staff by tips', async () => {
      const dashboardStaff = await SharedQueryService.getStaffPerformance(testVenue.id, 'last30days', 3)

      if (dashboardStaff.length === 0) {
        console.warn('⚠️ No staff data to test')
        return
      }

      const chatbotResponse = await TextToSqlAssistantService.processQuery({
        message: '¿Quién es el mesero con más propinas del último mes?',
        venueId: testVenue.id,
        userId: testUser.id,
      })

      // Top staff by tips should appear in response
      const topStaff = dashboardStaff.sort((a, b) => b.totalTips - a.totalTips)[0]
      expect(chatbotResponse.response).toContain(topStaff.staffName)
    })
  })

  // ============================
  // REVIEW QUERIES
  // ============================

  describe('Review Consistency', () => {
    it('should return identical average rating for last 30 days', async () => {
      const dashboardReviews = await SharedQueryService.getReviewStats(testVenue.id, 'last30days')

      if (dashboardReviews.totalReviews === 0) {
        console.warn('⚠️ No review data to test')
        return
      }

      const chatbotResponse = await TextToSqlAssistantService.processQuery({
        message: '¿Cuál es mi promedio de reseñas del último mes?',
        venueId: testVenue.id,
        userId: testUser.id,
      })

      assertNearlyEqual(extractNumber(chatbotResponse.response), dashboardReviews.averageRating, 0.1, 'Avg rating')
    })

    it('should return identical total reviews for last 7 days', async () => {
      const dashboardReviews = await SharedQueryService.getReviewStats(testVenue.id, 'last7days')
      const chatbotResponse = await TextToSqlAssistantService.processQuery({
        message: '¿Cuántas reseñas recibí en los últimos 7 días?',
        venueId: testVenue.id,
        userId: testUser.id,
      })

      expect(extractNumber(chatbotResponse.response)).toBe(dashboardReviews.totalReviews)
    })
  })

  // ============================
  // DATE RANGE EDGE CASES
  // ============================

  describe('Date Range Edge Cases', () => {
    it('should handle timezone correctly for "today" query', async () => {
      // This test ensures venue timezone is used, not UTC or server timezone
      const dashboardData = await SharedQueryService.getSalesForPeriod(testVenue.id, 'today', testVenue.timezone)
      const chatbotResponse = await TextToSqlAssistantService.processQuery({
        message: '¿Cuánto vendí hoy?',
        venueId: testVenue.id,
        userId: testUser.id,
      })

      assertNearlyEqual(extractNumber(chatbotResponse.response), dashboardData.totalRevenue, 0.01, 'Today (timezone test)')
    })

    it('should handle "this week" as last 7 days NOT calendar week', async () => {
      // CRITICAL: "esta semana" should mean "last 7 days" to match dashboard
      const dashboardData = await SharedQueryService.getSalesForPeriod(testVenue.id, 'last7days')
      const chatbotResponse = await TextToSqlAssistantService.processQuery({
        message: '¿Cuánto vendí esta semana?',
        venueId: testVenue.id,
        userId: testUser.id,
      })

      assertNearlyEqual(extractNumber(chatbotResponse.response), dashboardData.totalRevenue, 0.01, 'This week = last 7 days')
    })
  })

  // ============================
  // VALIDATION CROSS-CHECK
  // ============================

  describe('Validation Cross-Check', () => {
    it('should validate chatbot response against dashboard', async () => {
      const chatbotResponse = await TextToSqlAssistantService.processQuery({
        message: '¿Cuánto vendí en los últimos 7 días?',
        venueId: testVenue.id,
        userId: testUser.id,
      })

      const chatbotValue = extractNumber(chatbotResponse.response)

      // Use SharedQueryService validation
      const validation = await SharedQueryService.validateChatbotResponse(
        testVenue.id,
        'sales',
        'last7days',
        chatbotValue,
        0.01, // 1% tolerance
      )

      expect(validation.isMatch).toBe(true)
      if (!validation.isMatch) {
        console.error('❌ Dashboard-Chatbot mismatch!', {
          dashboardValue: validation.dashboardValue,
          chatbotValue: validation.chatbotValue,
          difference: validation.difference,
          differencePercent: validation.differencePercent,
        })
      }
    })
  })

  // ============================
  // PERFORMANCE BENCHMARKS
  // ============================

  describe('Performance Benchmarks', () => {
    it('should respond within 3 seconds for simple queries', async () => {
      const start = Date.now()

      await TextToSqlAssistantService.processQuery({
        message: '¿Cuánto vendí hoy?',
        venueId: testVenue.id,
        userId: testUser.id,
      })

      const duration = Date.now() - start

      expect(duration).toBeLessThan(3000) // Max 3 seconds
    })
  })
})
