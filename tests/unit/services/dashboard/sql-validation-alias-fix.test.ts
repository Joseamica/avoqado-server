/**
 * Unit Test: SQL Validation - Table Alias Handling
 *
 * REGRESSION TEST: Verifies that table aliases are parsed correctly
 *
 * Bug fixed: SqlValidationService was extracting aliases (o, oi, p) instead of
 * table names (Order, OrderItem, Product), causing "Invalid tables: o, o" error.
 *
 * This test ensures the fix works correctly.
 */

import { SqlValidationService } from '@/services/dashboard/sql-validation.service'

describe('SqlValidationService - Table Alias Handling (REGRESSION)', () => {
  it('should extract table names correctly when using aliases', () => {
    const sql = `
      SELECT p.name AS productName, SUM(oi.quantity) AS totalSold
      FROM "Order" o
      JOIN "OrderItem" oi ON o.id = oi.orderId
      JOIN "Product" p ON oi.productId = p.id
      WHERE o."venueId" = 'test-venue-id'
      AND p.name IN ('Hamburguesa', 'Pizza')
      AND EXTRACT(DOW FROM o."createdAt") IN (5, 6)
      AND EXTRACT(HOUR FROM o."createdAt") BETWEEN 18 AND 23
      GROUP BY p.name
    `

    const result = SqlValidationService.validateSchema(sql)

    // Debug: Log errors if any
    if (!result.isValid) {
      console.log('❌ Validation failed:', result.errors)
      console.log('Suggestions:', result.suggestions)
    }

    // Should pass validation (no invalid tables error)
    expect(result.isValid).toBe(true)
    expect(result.errors).toHaveLength(0)

    // Should NOT complain about aliases 'o', 'oi', 'p'
    expect(result.errors.some(e => e.includes('Invalid tables'))).toBe(false)
  })

  it('should validate complex query with multiple joins and aliases', () => {
    const sql = `
      SELECT
        s.firstName,
        s.lastName,
        COUNT(o.id) as orderCount,
        SUM(p.amount) as totalRevenue
      FROM "Staff" s
      JOIN "Order" o ON s.id = o.staffId
      JOIN "Payment" p ON o.id = p.orderId
      WHERE s."venueId" = 'test-venue-id'
      AND o."status" = 'COMPLETED'
      GROUP BY s.id, s.firstName, s.lastName
    `

    const result = SqlValidationService.validateSchema(sql)

    expect(result.isValid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('should still catch actually invalid table names', () => {
    const sql = `
      SELECT *
      FROM "InvalidTable" t
      WHERE t."venueId" = 'test-venue-id'
    `

    const result = SqlValidationService.validateSchema(sql)

    // Should fail validation
    expect(result.isValid).toBe(false)

    // Should report InvalidTable (not the alias 't')
    expect(result.errors.some(e => e.includes('InvalidTable'))).toBe(true)
    expect(result.errors.some(e => e.includes('Invalid tables'))).toBe(true)
  })

  it('should handle tables without aliases', () => {
    const sql = `
      SELECT *
      FROM "Order"
      WHERE "Order"."venueId" = 'test-venue-id'
    `

    const result = SqlValidationService.validateSchema(sql)

    expect(result.isValid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('should handle mixed: some tables with aliases, some without', () => {
    const sql = `
      SELECT *
      FROM "Order" o
      JOIN "OrderItem" ON "OrderItem"."orderId" = o.id
      WHERE o."venueId" = 'test-venue-id'
    `

    const result = SqlValidationService.validateSchema(sql)

    expect(result.isValid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('should handle the exact SQL from production error log', () => {
    // This is the exact SQL that failed in production
    const sql = `
      SELECT p.name AS productName, SUM(oi.quantity) AS totalSold
      FROM "Order" o
      JOIN "OrderItem" oi ON o.id = oi.orderId
      JOIN "Product" p ON oi.productId = p.id
      WHERE o."venueId" = 'cmhcbnp7z009h9k0827azxien'
      AND p.name IN ('Hamburguesa', 'Pizza')
      AND EXTRACT(DOW FROM o."createdAt") IN (5, 6)
      AND EXTRACT(HOUR FROM o."createdAt") BETWEEN 18 AND 23
      AND o."status" = 'COMPLETED'
      GROUP BY p.name
    `

    const result = SqlValidationService.validateSchema(sql)

    // This should NOW pass (previously failed with "Invalid tables: o, o")
    expect(result.isValid).toBe(true)
    expect(result.errors).toHaveLength(0)

    // Specifically verify no "Invalid tables" error
    const hasInvalidTablesError = result.errors.some(e => e.includes('Invalid tables'))
    expect(hasInvalidTablesError).toBe(false)
  })
})
