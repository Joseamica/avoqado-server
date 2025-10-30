/**
 * Unit Tests: Text-to-SQL Assistant Service
 *
 * Tests core logic WITHOUT database dependencies:
 * - Complexity detection
 * - Importance detection
 * - Consensus voting logic (findConsensus, deepEqual)
 * - Layer 6 sanity checks
 *
 * World-Class Pattern: Unit tests should be FAST (<100ms) and test pure logic
 */

import { describe, it, expect } from '@jest/globals'
import textToSqlService from '@/services/dashboard/text-to-sql-assistant.service'

describe('TextToSqlAssistantService - Unit Tests', () => {
  const service = textToSqlService

  describe('Complexity Detection', () => {
    it('should detect complex queries with comparisons (vs, versus)', () => {
      const complexQuery = '¿Cuánto vendí de hamburguesas vs pizzas?'
      // @ts-expect-error - accessing private method for testing
      const isComplex = service.detectComplexity(complexQuery)
      expect(isComplex).toBe(true)
    })

    it('should detect complex queries with time filters', () => {
      const timeFilterQuery = '¿Qué mesero vendió más después de las 8pm?'
      // @ts-expect-error - accessing private method for testing
      const isComplex = service.detectComplexity(timeFilterQuery)
      expect(isComplex).toBe(true)
    })

    it('should detect complex queries with day filters', () => {
      const dayFilterQuery = '¿Cuánto vendí los fines de semana?'
      // @ts-expect-error - accessing private method for testing
      const isComplex = service.detectComplexity(dayFilterQuery)
      expect(isComplex).toBe(true)
    })

    it('should NOT detect simple queries as complex', () => {
      const simpleQuery = '¿Cuánto vendí hoy?'
      // @ts-expect-error - accessing private method for testing
      const isComplex = service.detectComplexity(simpleQuery)
      expect(isComplex).toBe(false)
    })

    it('should detect multiple dimension queries (y, con, junto)', () => {
      const multiDimQuery = '¿Cuánto vendí de bebidas y postres?'
      // @ts-expect-error - accessing private method for testing
      const isComplex = service.detectComplexity(multiDimQuery)
      expect(isComplex).toBe(true)
    })

    it('should detect specific date queries', () => {
      const specificDateQuery = '¿Quién vendió más el 3 de septiembre de 2024?'
      // @ts-expect-error - accessing private method for testing
      const isComplex = service.detectComplexity(specificDateQuery)
      expect(isComplex).toBe(true)
    })
  })

  describe('Importance Detection', () => {
    it('should detect important queries with rankings', () => {
      const rankingQuery = '¿Quién es el mejor mesero?'
      // @ts-expect-error - accessing private method for testing
      const isImportant = service.detectImportance(rankingQuery)
      expect(isImportant).toBe(true)
    })

    it('should detect important queries with comparisons', () => {
      const comparisonQuery = '¿Cuál es la diferencia entre ventas de enero y febrero?'
      // @ts-expect-error - accessing private method for testing
      const isImportant = service.detectImportance(comparisonQuery)
      expect(isImportant).toBe(true)
    })

    it('should detect important queries with strategic keywords', () => {
      const strategicQuery = '¿Debería aumentar el precio de las hamburguesas?'
      // @ts-expect-error - accessing private method for testing
      const isImportant = service.detectImportance(strategicQuery)
      expect(isImportant).toBe(true)
    })

    it('should NOT detect simple informational queries as important', () => {
      const simpleQuery = '¿Cuántas órdenes tuve hoy?'
      // @ts-expect-error - accessing private method for testing
      const isImportant = service.detectImportance(simpleQuery)
      expect(isImportant).toBe(false)
    })
  })

  describe('Consensus Voting Logic - deepEqual()', () => {
    it('should detect exact equality for primitives', () => {
      // @ts-expect-error - accessing private method for testing
      expect(service.deepEqual(5, 5)).toBe(true)
      // @ts-expect-error - accessing private method for testing
      expect(service.deepEqual('hello', 'hello')).toBe(true)
      // @ts-expect-error - accessing private method for testing
      expect(service.deepEqual(true, true)).toBe(true)
    })

    it('should detect inequality for different primitives', () => {
      // @ts-expect-error - accessing private method for testing
      expect(service.deepEqual(5, 6)).toBe(false)
      // @ts-expect-error - accessing private method for testing
      expect(service.deepEqual('hello', 'world')).toBe(false)
      // @ts-expect-error - accessing private method for testing
      expect(service.deepEqual(true, false)).toBe(false)
    })

    it('should use 1% tolerance for numeric comparisons', () => {
      // 12500 and 12525 are within 1% (0.2% difference)
      // @ts-expect-error - accessing private method for testing
      expect(service.deepEqual(12500, 12525, 0.01)).toBe(true)

      // 12500 and 13000 are NOT within 1% (4% difference)
      // @ts-expect-error - accessing private method for testing
      expect(service.deepEqual(12500, 13000, 0.01)).toBe(false)
    })

    it('should compare arrays of objects deeply', () => {
      const arr1 = [
        { name: 'Burger', quantity: 10, revenue: 250.0 },
        { name: 'Pizza', quantity: 5, revenue: 150.0 },
      ]
      const arr2 = [
        { name: 'Burger', quantity: 10, revenue: 250.5 }, // Within 1% tolerance
        { name: 'Pizza', quantity: 5, revenue: 150.0 },
      ]

      // @ts-expect-error - accessing private method for testing
      expect(service.deepEqual(arr1, arr2, 0.01)).toBe(true)
    })

    it('should detect mismatch in array length', () => {
      const arr1 = [{ name: 'Burger', quantity: 10 }]
      const arr2 = [
        { name: 'Burger', quantity: 10 },
        { name: 'Pizza', quantity: 5 },
      ]

      // @ts-expect-error - accessing private method for testing
      expect(service.deepEqual(arr1, arr2)).toBe(false)
    })

    it('should detect mismatch in object keys', () => {
      const obj1 = { name: 'Burger', quantity: 10 }
      const obj2 = { name: 'Burger', price: 25.0 }

      // @ts-expect-error - accessing private method for testing
      expect(service.deepEqual(obj1, obj2)).toBe(false)
    })
  })

  describe('Consensus Voting Logic - findConsensus()', () => {
    it('should return high confidence (100%) when all 3 results match', () => {
      const result1 = [{ total: 12500 }]
      const result2 = [{ total: 12525 }] // Within 1% tolerance
      const result3 = [{ total: 12510 }] // Within 1% tolerance

      // Mock deepEqual to return true for all comparisons
      // @ts-expect-error - accessing private method for testing
      const originalDeepEqual = service.deepEqual.bind(service)
      // @ts-expect-error - accessing private method for testing
      service.deepEqual = () => true

      // @ts-expect-error - accessing private method for testing
      const consensus = service.findConsensus([result1, result2, result3])

      expect(consensus.confidence).toBe('high')
      expect(consensus.agreementPercent).toBe(100)

      // Restore original method
      // @ts-expect-error - accessing private method for testing
      service.deepEqual = originalDeepEqual
    })

    it('should return high confidence (66%) when 2 out of 3 results match', () => {
      const result1 = [{ total: 12500 }]
      const result2 = [{ total: 12525 }] // Matches result1
      const result3 = [{ total: 15000 }] // Different

      // Mock deepEqual to return true only for result1 vs result2
      let callCount = 0
      // @ts-expect-error - accessing private method for testing
      const originalDeepEqual = service.deepEqual.bind(service)
      // @ts-expect-error - accessing private method for testing
      service.deepEqual = () => {
        callCount++
        return callCount === 1 // First comparison (result1 vs result2) matches
      }

      // @ts-expect-error - accessing private method for testing
      const consensus = service.findConsensus([result1, result2, result3])

      expect(consensus.confidence).toBe('high')
      expect(consensus.agreementPercent).toBe(66)

      // Restore original method
      // @ts-expect-error - accessing private method for testing
      service.deepEqual = originalDeepEqual
    })

    it('should return low confidence (33%) when no results match', () => {
      const result1 = [{ total: 12500 }]
      const result2 = [{ total: 15000 }]
      const result3 = [{ total: 18000 }]

      // Mock deepEqual to return false for all comparisons
      // @ts-expect-error - accessing private method for testing
      const originalDeepEqual = service.deepEqual.bind(service)
      // @ts-expect-error - accessing private method for testing
      service.deepEqual = () => false

      // @ts-expect-error - accessing private method for testing
      const consensus = service.findConsensus([result1, result2, result3])

      expect(consensus.confidence).toBe('low')
      expect(consensus.agreementPercent).toBe(33)

      // Restore original method
      // @ts-expect-error - accessing private method for testing
      service.deepEqual = originalDeepEqual
    })

    it('should handle single result (low confidence 33%)', () => {
      const result1 = [{ total: 12500 }]

      // @ts-expect-error - accessing private method for testing
      const consensus = service.findConsensus([result1])

      expect(consensus.confidence).toBe('low')
      expect(consensus.agreementPercent).toBe(33)
    })

    it('should handle two results with match (high confidence 100%)', () => {
      const result1 = [{ total: 12500 }]
      const result2 = [{ total: 12525 }] // Within tolerance

      // Mock deepEqual to return true
      // @ts-expect-error - accessing private method for testing
      const originalDeepEqual = service.deepEqual.bind(service)
      // @ts-expect-error - accessing private method for testing
      service.deepEqual = () => true

      // @ts-expect-error - accessing private method for testing
      const consensus = service.findConsensus([result1, result2])

      expect(consensus.confidence).toBe('high')
      expect(consensus.agreementPercent).toBe(100)

      // Restore original method
      // @ts-expect-error - accessing private method for testing
      service.deepEqual = originalDeepEqual
    })
  })

  describe('Layer 6 Sanity Checks - extractTotalFromResult()', () => {
    it('should extract total from single row result', () => {
      const result = [{ total: 12500.75 }]
      // @ts-expect-error - accessing private method for testing
      const total = service.extractTotalFromResult(result)
      expect(total).toBe(12500.75)
    })

    it('should extract revenue from single row result', () => {
      const result = [{ revenue: 8500.5 }]
      // @ts-expect-error - accessing private method for testing
      const total = service.extractTotalFromResult(result)
      expect(total).toBe(8500.5)
    })

    it('should sum total_sales across multiple rows', () => {
      const result = [
        { product: 'Burger', total_sales: 5000 },
        { product: 'Pizza', total_sales: 3500 },
        { product: 'Drink', total_sales: 1500 },
      ]
      // @ts-expect-error - accessing private method for testing
      const total = service.extractTotalFromResult(result)
      expect(total).toBe(10000)
    })

    it('should return null if no total field found', () => {
      const result = [{ name: 'Burger', quantity: 10 }]
      // @ts-expect-error - accessing private method for testing
      const total = service.extractTotalFromResult(result)
      expect(total).toBeNull()
    })

    it('should handle empty result array', () => {
      const result: any[] = []
      // @ts-expect-error - accessing private method for testing
      const total = service.extractTotalFromResult(result)
      expect(total).toBeNull()
    })
  })
})
