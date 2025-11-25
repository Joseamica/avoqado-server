/**
 * Test: SQL AST Parser - Column Type Handling
 *
 * Verifies that the parser correctly handles different column reference types
 * returned by node-sql-parser (string, array, object).
 *
 * Bug Fixed: "whereExpr.left.column?.toLowerCase is not a function"
 * Cause: node-sql-parser returns different types for column references
 * Fix: Added extractColumnName() helper with type-safe handling
 */

import { SqlAstParserService } from '@/services/dashboard/sql-ast-parser.service'

describe('SqlAstParserService - Column Type Handling', () => {
  let service: SqlAstParserService
  const testVenueId = 'venue-test-123'

  beforeEach(() => {
    service = new SqlAstParserService()
  })

  describe('Simple column references (string)', () => {
    it('should validate query with simple venueId column', () => {
      const sql = `SELECT * FROM "Order" WHERE venueId = '${testVenueId}'`

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
      expect(result.details?.hasVenueFilter).toBe(true)
      expect(result.details?.venueFilterValue).toBe(testVenueId)
    })

    it('should validate query with case-insensitive venueId', () => {
      const sql = `SELECT * FROM "Order" WHERE VENUEID = '${testVenueId}'`

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      expect(result.valid).toBe(true)
      expect(result.details?.hasVenueFilter).toBe(true)
    })
  })

  describe('Table-qualified columns (array)', () => {
    it('should validate query with table-qualified venueId', () => {
      // node-sql-parser represents "Order.venueId" as array ["Order", "venueId"]
      const sql = `SELECT * FROM "Order" WHERE "Order".venueId = '${testVenueId}'`

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      expect(result.valid).toBe(true)
      expect(result.details?.hasVenueFilter).toBe(true)
      expect(result.details?.venueFilterValue).toBe(testVenueId)
    })

    it('should validate query with multiple table-qualified columns in AND', () => {
      const sql = `
        SELECT * FROM "Order"
        WHERE "Order".venueId = '${testVenueId}'
        AND "Order".status = 'COMPLETED'
      `

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      expect(result.valid).toBe(true)
      expect(result.details?.hasVenueFilter).toBe(true)
    })
  })

  describe('Complex WHERE clauses', () => {
    it('should validate query with venueId in nested AND conditions', () => {
      const sql = `
        SELECT * FROM "Order"
        WHERE status = 'COMPLETED'
        AND venueId = '${testVenueId}'
        AND totalPrice > 100
      `

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      expect(result.valid).toBe(true)
      expect(result.details?.hasVenueFilter).toBe(true)
    })

    it('should reject query with venueId in OR condition (security)', () => {
      const sql = `
        SELECT * FROM "Order"
        WHERE venueId = '${testVenueId}' OR 1=1
      `

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      // SECURITY: System intentionally doesn't recognize venueId inside OR conditions
      // This prevents bypass attacks like: WHERE venueId='correct' OR 1=1
      expect(result.valid).toBe(false)
      expect(result.details?.hasVenueFilter).toBe(false) // Correctly rejects OR conditions
      expect(result.errors[0]).toContain('Query MUST include a WHERE filter with venueId')
    })
  })

  describe('Edge cases and error handling', () => {
    it('should reject query without venueId filter', () => {
      const sql = `SELECT * FROM "Order" WHERE status = 'COMPLETED'`

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      expect(result.valid).toBe(false)
      expect(result.errors).toContain(`Query MUST include a WHERE filter with venueId = '${testVenueId}' for tenant isolation`)
    })

    it('should reject query with wrong venueId value', () => {
      const sql = `SELECT * FROM "Order" WHERE venueId = 'wrong-venue-id'`

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      expect(result.valid).toBe(false)
      expect(result.errors[0]).toContain('does not match required')
    })

    it('should handle complex SQL without crashing', () => {
      const sql = `
        SELECT
          o.*,
          COUNT(*) as total
        FROM "Order" o
        WHERE o.venueId = '${testVenueId}'
        GROUP BY o.id
        HAVING COUNT(*) > 1
      `

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      expect(result.valid).toBe(true)
      expect(result.details?.hasVenueFilter).toBe(true)
    })
  })

  describe('Regression test: Bug fix verification', () => {
    it('should not throw "toLowerCase is not a function" error', () => {
      // This test specifically verifies the bug fix for column type handling
      const queries = [
        `SELECT * FROM "Order" WHERE venueId = '${testVenueId}'`, // String
        `SELECT * FROM "Order" WHERE "Order".venueId = '${testVenueId}'`, // Array
        `SELECT * FROM "Order" o WHERE o.venueId = '${testVenueId}'`, // Alias
      ]

      queries.forEach(sql => {
        expect(() => {
          service.validateQuery(sql, { requiredVenueId: testVenueId })
        }).not.toThrow()
      })
    })

    it('should handle the original failing query from logs', () => {
      // Simulate the type of query that caused the original error
      const sql = `
        SELECT
          "Product".name,
          COUNT("OrderItem".id) as total_sales
        FROM "Product"
        JOIN "OrderItem" ON "Product".id = "OrderItem"."productId"
        JOIN "Order" ON "OrderItem"."orderId" = "Order".id
        WHERE "Order".venueId = '${testVenueId}'
        GROUP BY "Product".name
        ORDER BY total_sales DESC
        LIMIT 10
      `

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      // Should not crash and should find the venueId filter
      expect(result.valid).toBe(true)
      expect(result.details?.hasVenueFilter).toBe(true)
    })
  })
})
