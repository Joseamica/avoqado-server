/**
 * Test: SQL Validation Service - EXTRACT Function Handling
 *
 * Verifies that EXTRACT(HOUR FROM "column") patterns are NOT treated as table references.
 * Bug fixed: 2025-11-25
 *
 * The issue was that the regex /\b(?:from|join)\s+"(\w+)"/gi would match:
 * - FROM "Order" (correct - table reference)
 * - FROM "createdAt" inside EXTRACT() (incorrect - column reference)
 */

import { SqlValidationService } from '@/services/dashboard/sql-validation.service'

describe('SqlValidationService - EXTRACT Function Handling', () => {
  const testVenueId = 'venue-test-123'

  describe('🛡️ EXTRACT Function Should Not Extract Column as Table', () => {
    it('should NOT extract "createdAt" as table from EXTRACT(HOUR FROM "createdAt")', () => {
      const sql = `
        SELECT EXTRACT(HOUR FROM "createdAt") AS hour, SUM("amount") AS totalSales
        FROM "Payment"
        WHERE "venueId" = '${testVenueId}' AND "status" = 'COMPLETED'
        GROUP BY hour
        ORDER BY totalSales DESC
      `

      const result = SqlValidationService.validateSchema(sql)

      // Should be valid - "createdAt" is a column, not a table
      expect(result.isValid).toBe(true)
      expect(result.errors).not.toContain(expect.stringContaining('createdAt'))
    })

    it('should correctly extract "Order" as table when EXTRACT is also present', () => {
      const sql = `
        SELECT EXTRACT(DOW FROM "createdAt") AS dayOfWeek, COUNT(*) as orders
        FROM "Order"
        WHERE "venueId" = '${testVenueId}'
        GROUP BY dayOfWeek
      `

      const result = SqlValidationService.validateSchema(sql)

      // Should be valid - "Order" is a valid table
      expect(result.isValid).toBe(true)
    })

    it('should handle multiple EXTRACT functions in same query', () => {
      const sql = `
        SELECT
          EXTRACT(YEAR FROM "createdAt") AS year,
          EXTRACT(MONTH FROM "createdAt") AS month,
          EXTRACT(DAY FROM "createdAt") AS day,
          SUM("total") as revenue
        FROM "Order"
        WHERE "venueId" = '${testVenueId}'
        GROUP BY year, month, day
      `

      const result = SqlValidationService.validateSchema(sql)

      expect(result.isValid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it('should handle DATE_PART function similarly', () => {
      const sql = `
        SELECT DATE_PART('hour', "createdAt") AS hour, COUNT(*) as count
        FROM "Payment"
        WHERE "venueId" = '${testVenueId}'
        GROUP BY hour
      `

      const result = SqlValidationService.validateSchema(sql)

      expect(result.isValid).toBe(true)
    })

    it('should still reject invalid tables', () => {
      const sql = `
        SELECT EXTRACT(HOUR FROM "createdAt") AS hour
        FROM "InvalidTable"
        WHERE "venueId" = '${testVenueId}'
      `

      const result = SqlValidationService.validateSchema(sql)

      expect(result.isValid).toBe(false)
      expect(result.errors[0]).toContain('InvalidTable')
    })

    it('should handle complex query with JOINs and EXTRACT', () => {
      const sql = `
        SELECT
          EXTRACT(HOUR FROM o."createdAt") AS hour,
          COUNT(*) as orders,
          SUM(p."amount") as revenue
        FROM "Order" o
        JOIN "Payment" p ON o.id = p."orderId"
        WHERE o."venueId" = '${testVenueId}'
        GROUP BY hour
        ORDER BY revenue DESC
      `

      const result = SqlValidationService.validateSchema(sql)

      // Both "Order" and "Payment" are valid tables
      expect(result.isValid).toBe(true)
    })
  })

  describe('✅ Standard FROM/JOIN extraction still works', () => {
    it('should extract single table correctly', () => {
      const sql = `SELECT * FROM "Order" WHERE "venueId" = '${testVenueId}'`

      const result = SqlValidationService.validateSchema(sql)

      expect(result.isValid).toBe(true)
    })

    it('should extract multiple tables from JOIN', () => {
      const sql = `
        SELECT o.*, p.*
        FROM "Order" o
        JOIN "Payment" p ON o.id = p."orderId"
        LEFT JOIN "OrderItem" oi ON o.id = oi."orderId"
        WHERE o."venueId" = '${testVenueId}'
      `

      const result = SqlValidationService.validateSchema(sql)

      expect(result.isValid).toBe(true)
    })
  })
})
