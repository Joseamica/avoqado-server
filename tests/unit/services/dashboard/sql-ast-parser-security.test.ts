/**
 * Test: SQL AST Parser - Security Features
 *
 * Verifies security implementations in the SQL AST Parser:
 * - OR condition bypass prevention ✅ IMPLEMENTED
 * - VenueId value tampering prevention ✅ IMPLEMENTED
 * - Basic tenant isolation ✅ IMPLEMENTED
 *
 * Features marked TODO need implementation:
 * - Subquery venueId validation
 * - Always-true condition detection
 * - UNION injection detection
 * - Comment injection detection
 * - Stacked queries prevention
 *
 * These tests don't require OpenAI API calls and can run in CI/CD.
 */

import { SqlAstParserService } from '@/services/dashboard/sql-ast-parser.service'

describe('SqlAstParserService - Security Features', () => {
  let service: SqlAstParserService
  const testVenueId = 'venue-security-test-123'
  const attackerVenueId = 'attacker-venue-456'

  beforeEach(() => {
    service = new SqlAstParserService()
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // OR CONDITION BYPASS PREVENTION ✅ IMPLEMENTED
  // ═══════════════════════════════════════════════════════════════════════════
  describe('🛡️ OR Condition Bypass Prevention', () => {
    it('should REJECT venueId inside OR condition (prevents bypass)', () => {
      // Attack: WHERE venueId='correct' OR 1=1 → returns ALL data
      const sql = `SELECT * FROM "Order" WHERE venueId = '${testVenueId}' OR 1=1`

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      expect(result.valid).toBe(false)
      expect(result.details?.hasVenueFilter).toBe(false)
    })

    it('should REJECT venueId in OR with another venueId (multi-venue attack)', () => {
      // Attack: Access data from multiple venues
      const sql = `SELECT * FROM "Order" WHERE venueId = '${testVenueId}' OR venueId = '${attackerVenueId}'`

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      expect(result.valid).toBe(false)
    })

    it('should REJECT venueId in complex OR condition', () => {
      // Attack: Nested OR conditions
      const sql = `
        SELECT * FROM "Order"
        WHERE (venueId = '${testVenueId}' OR status = 'PENDING')
        AND totalPrice > 0
      `

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      // venueId is inside OR, so should not count as valid filter
      expect(result.valid).toBe(false)
    })

    // NOTE: Current implementation is strict - ANY OR at the top level invalidates venueId
    // This is a security-first approach that may require refinement for legitimate use cases
    it('should handle venueId in AND with separate OR clause', () => {
      // Current behavior: Strict - rejects even when venueId is correctly in AND
      const sql = `
        SELECT * FROM "Order"
        WHERE venueId = '${testVenueId}'
        AND (status = 'COMPLETED' OR status = 'PENDING')
      `

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      // Current implementation: strict rejection due to OR presence
      // Future enhancement: Parse deeper to allow OR on non-venueId fields
      // For now, document the behavior
      expect(result.valid).toBe(false) // Strict mode - may need refinement
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // VENUEID VALUE TAMPERING PREVENTION ✅ IMPLEMENTED
  // ═══════════════════════════════════════════════════════════════════════════
  describe('🛡️ VenueId Value Tampering Prevention', () => {
    it('should REJECT different venueId than authenticated', () => {
      const sql = `SELECT * FROM "Order" WHERE venueId = '${attackerVenueId}'`

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      expect(result.valid).toBe(false)
      expect(result.errors[0]).toContain('does not match')
    })

    it('should REJECT venueId with SQL injection in value', () => {
      const maliciousValue = "test' OR '1'='1"
      const sql = `SELECT * FROM "Order" WHERE venueId = '${maliciousValue}'`

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      expect(result.valid).toBe(false)
    })

    it('should REJECT LIKE pattern on venueId', () => {
      const sql = `SELECT * FROM "Order" WHERE venueId LIKE '%'`

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      expect(result.valid).toBe(false)
    })

    it('should REJECT venueId with IN clause containing multiple values', () => {
      const sql = `SELECT * FROM "Order" WHERE venueId IN ('${testVenueId}', '${attackerVenueId}')`

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      expect(result.valid).toBe(false)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // SYSTEM CATALOG ACCESS PREVENTION ✅ IMPLEMENTED (via tenant isolation)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('🛡️ System Catalog Access Prevention', () => {
    it('should REJECT information_schema access (no venueId filter possible)', () => {
      const sql = `SELECT * FROM information_schema.tables`

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      // Blocked because system tables don't have venueId
      expect(result.valid).toBe(false)
    })

    it('should REJECT pg_catalog access (no venueId filter possible)', () => {
      const sql = `SELECT * FROM pg_catalog.pg_tables`

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      expect(result.valid).toBe(false)
    })

    it('should REJECT sys schema access', () => {
      const sql = `SELECT * FROM sys.tables`

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      expect(result.valid).toBe(false)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // LEGITIMATE QUERIES (Positive Tests) ✅ IMPLEMENTED
  // ═══════════════════════════════════════════════════════════════════════════
  describe('✅ Legitimate Queries (Should Pass)', () => {
    it('should ACCEPT simple SELECT with valid venueId', () => {
      const sql = `SELECT * FROM "Order" WHERE venueId = '${testVenueId}'`

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      expect(result.valid).toBe(true)
    })

    it('should ACCEPT JOIN queries with venueId filter', () => {
      const sql = `
        SELECT o.*, p.name as productName
        FROM "Order" o
        JOIN "OrderItem" oi ON o.id = oi.orderId
        JOIN "Product" p ON oi.productId = p.id
        WHERE o.venueId = '${testVenueId}'
      `

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      expect(result.valid).toBe(true)
    })

    it('should ACCEPT aggregate queries with venueId filter', () => {
      const sql = `
        SELECT
          DATE_TRUNC('day', "createdAt") as date,
          COUNT(*) as total,
          SUM("totalPrice") as revenue
        FROM "Order"
        WHERE venueId = '${testVenueId}'
        GROUP BY DATE_TRUNC('day', "createdAt")
        ORDER BY date DESC
        LIMIT 30
      `

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      expect(result.valid).toBe(true)
    })

    it('should ACCEPT queries with multiple AND conditions', () => {
      const sql = `
        SELECT * FROM "Order"
        WHERE venueId = '${testVenueId}'
        AND status = 'COMPLETED'
        AND totalPrice > 100
        AND createdAt > '2024-01-01'
      `

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      expect(result.valid).toBe(true)
    })

    it('should ACCEPT queries with table-qualified venueId', () => {
      const sql = `SELECT * FROM "Order" o WHERE o.venueId = '${testVenueId}'`

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      expect(result.valid).toBe(true)
    })

    it('should ACCEPT queries with EXTRACT function (column should NOT be treated as table)', () => {
      // This was a bug where EXTRACT(HOUR FROM "createdAt") caused "createdAt" to be treated as a table
      const sql = `
        SELECT EXTRACT(HOUR FROM "createdAt") AS hour, SUM("amount") AS totalSales
        FROM "Payment"
        WHERE "venueId" = '${testVenueId}' AND "status" = 'COMPLETED'
        GROUP BY hour
        ORDER BY totalSales DESC
      `

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      expect(result.valid).toBe(true)
      expect(result.details?.tablesAccessed).toContain('Payment')
      expect(result.details?.tablesAccessed).not.toContain('createdAt')
    })

    it('should ACCEPT queries with DATE_TRUNC function', () => {
      const sql = `
        SELECT DATE_TRUNC('day', "createdAt") as date, COUNT(*) as count
        FROM "Order"
        WHERE venueId = '${testVenueId}'
        GROUP BY DATE_TRUNC('day', "createdAt")
      `

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      expect(result.valid).toBe(true)
      expect(result.details?.tablesAccessed).toContain('Order')
    })

    it('should ACCEPT queries with nested functions (COALESCE, CAST, etc)', () => {
      const sql = `
        SELECT COALESCE(SUM(CAST("amount" AS decimal)), 0) as total
        FROM "Payment"
        WHERE venueId = '${testVenueId}'
      `

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      expect(result.valid).toBe(true)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // FUTURE SECURITY ENHANCEMENTS (TODO - Not Yet Implemented)
  // These tests document desired security features for future implementation
  // ═══════════════════════════════════════════════════════════════════════════
  describe.skip('📋 TODO: Subquery Security (Future Enhancement)', () => {
    it('should WARN about subquery that could bypass venueId', () => {
      const sql = `
        SELECT * FROM "Product"
        WHERE venueId = '${testVenueId}'
        AND categoryId IN (SELECT id FROM "MenuCategory" WHERE name = 'Secret')
      `

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      expect(result.warnings.length).toBeGreaterThan(0)
    })

    it('should DETECT venueId set via subquery (bypass attempt)', () => {
      const sql = `SELECT * FROM "Product" WHERE venueId = (SELECT id FROM "Venue" LIMIT 1)`

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      expect(result.valid).toBe(false)
      expect(result.warnings.join(' ')).toContain('subquery')
    })
  })

  describe.skip('📋 TODO: Always-True Condition Detection (Future Enhancement)', () => {
    it('should DETECT 1=1 bypass attempt', () => {
      const sql = `SELECT * FROM "Order" WHERE venueId = '${testVenueId}' AND 1=1`

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      expect(result.warnings).toContain(expect.stringContaining('always-true'))
    })

    it('should DETECT true boolean literal', () => {
      const sql = `SELECT * FROM "Order" WHERE venueId = '${testVenueId}' AND true`

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      expect(result.warnings).toContain(expect.stringContaining('always-true'))
    })
  })

  describe.skip('📋 TODO: UNION Injection Prevention (Future Enhancement)', () => {
    it('should DETECT UNION SELECT injection', () => {
      const sql = `
        SELECT name FROM "Product" WHERE venueId = '${testVenueId}'
        UNION SELECT password FROM "User"
      `

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      expect(result.warnings).toContain(expect.stringContaining('UNION'))
    })
  })

  describe.skip('📋 TODO: Comment Injection Prevention (Future Enhancement)', () => {
    it('should DETECT inline comment bypass attempt', () => {
      const sql = `SELECT * FROM "Order" WHERE venueId = '${testVenueId}' -- AND isActive = true`

      const result = service.validateQuery(sql, {
        requiredVenueId: testVenueId,
      })

      expect(result.warnings.length).toBeGreaterThan(0)
    })
  })

  describe.skip('📋 TODO: Stacked Queries Prevention (Future Enhancement)', () => {
    it('should REJECT DROP TABLE injection', () => {
      const sql = `SELECT * FROM "Order" WHERE venueId = '${testVenueId}'; DROP TABLE "Order";`

      expect(() => {
        service.validateQuery(sql, { requiredVenueId: testVenueId })
      }).toThrow()
    })
  })
})
