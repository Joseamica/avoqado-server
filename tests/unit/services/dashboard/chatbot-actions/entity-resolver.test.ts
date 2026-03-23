import prisma from '@/utils/prismaClient'
import { EntityResolverService } from '@/services/dashboard/chatbot-actions/entity-resolver.service'
import { EntityResolutionConfig } from '@/services/dashboard/chatbot-actions/types'

// ---------------------------------------------------------------------------
// Mock prisma
// ---------------------------------------------------------------------------

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $queryRaw: jest.fn(),
  },
}))

const mockQueryRaw = prisma.$queryRaw as jest.Mock

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VENUE_ID = 'venue-test-123'

function makeConfig(overrides: Partial<EntityResolutionConfig> = {}): EntityResolutionConfig {
  return {
    searchField: 'name',
    scope: 'venueId',
    fuzzyMatch: true,
    multipleMatchBehavior: 'ask',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EntityResolverService', () => {
  let service: EntityResolverService

  beforeEach(() => {
    service = new EntityResolverService()
    jest.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // Exact match
  // -------------------------------------------------------------------------

  describe('exact match', () => {
    it('should return score 1.0 and exact: true on exact match', async () => {
      mockQueryRaw.mockResolvedValueOnce([{ id: 'rm-1', name: 'Carne Molida' }])

      const result = await service.resolve('RawMaterial', 'Carne Molida', VENUE_ID, makeConfig(), 'update')

      expect(result.matches).toBe(1)
      expect(result.exact).toBe(true)
      expect(result.resolved).toBeDefined()
      expect(result.resolved!.id).toBe('rm-1')
      expect(result.resolved!.score).toBe(1.0)
    })

    it('should set resolved when exactly one exact match is found', async () => {
      mockQueryRaw.mockResolvedValueOnce([{ id: 'rm-1', name: 'Carne Molida' }])

      const result = await service.resolve('RawMaterial', 'Carne Molida', VENUE_ID, makeConfig(), 'update')

      expect(result.resolved).toEqual({ id: 'rm-1', name: 'Carne Molida', score: 1.0, data: {} })
    })

    it('should return multiple candidates when multiple exact matches found', async () => {
      mockQueryRaw.mockResolvedValueOnce([
        { id: 'rm-1', name: 'Carne Molida' },
        { id: 'rm-2', name: 'Carne Molida' },
      ])

      const result = await service.resolve('RawMaterial', 'Carne Molida', VENUE_ID, makeConfig(), 'update')

      expect(result.matches).toBe(2)
      expect(result.exact).toBe(false)
      expect(result.resolved).toBeUndefined()
      expect(result.candidates).toHaveLength(2)
    })
  })

  // -------------------------------------------------------------------------
  // Fuzzy match
  // -------------------------------------------------------------------------

  describe('fuzzy match', () => {
    it('should fall through to fuzzy when no exact match found', async () => {
      // Exact → empty, fuzzy → one result
      mockQueryRaw
        .mockResolvedValueOnce([]) // exact
        .mockResolvedValueOnce([{ id: 'rm-2', name: 'Carne de Res', score: 0.65 }]) // fuzzy

      const result = await service.resolve('RawMaterial', 'karne', VENUE_ID, makeConfig(), 'update')

      expect(result.matches).toBe(1)
      expect(result.exact).toBe(false)
      expect(result.resolved!.score).toBeCloseTo(0.65)
    })

    it('should return sorted candidates when multiple fuzzy matches found', async () => {
      mockQueryRaw
        .mockResolvedValueOnce([]) // exact
        .mockResolvedValueOnce([
          { id: 'rm-3', name: 'Carne de Puerco', score: 0.55 },
          { id: 'rm-2', name: 'Carne de Res', score: 0.72 },
          { id: 'rm-1', name: 'Carne Molida', score: 0.8 },
        ]) // fuzzy (DB already sorted)

      const result = await service.resolve('RawMaterial', 'karne', VENUE_ID, makeConfig(), 'update')

      expect(result.matches).toBe(3)
      expect(result.exact).toBe(false)
      expect(result.resolved).toBeUndefined()
      // Candidates preserve order from DB (sorted DESC by similarity)
      expect(result.candidates[0].score).toBeCloseTo(0.55)
      expect(result.candidates[1].score).toBeCloseTo(0.72)
      expect(result.candidates[2].score).toBeCloseTo(0.8)
    })

    it('should skip fuzzy step when config.fuzzyMatch is false', async () => {
      mockQueryRaw.mockResolvedValueOnce([]) // exact → no match
      // No fuzzy call expected
      // SKU fallback next
      mockQueryRaw.mockResolvedValueOnce([]) // sku

      const result = await service.resolve('RawMaterial', 'karne', VENUE_ID, makeConfig({ fuzzyMatch: false }), 'update')

      expect(result.matches).toBe(0)
      // Only 2 calls: exact + sku (no fuzzy)
      expect(mockQueryRaw).toHaveBeenCalledTimes(2)
    })
  })

  // -------------------------------------------------------------------------
  // No match
  // -------------------------------------------------------------------------

  describe('no match', () => {
    it('should return { matches: 0, candidates: [], exact: false } when nothing found', async () => {
      mockQueryRaw
        .mockResolvedValueOnce([]) // exact
        .mockResolvedValueOnce([]) // fuzzy
        .mockResolvedValueOnce([]) // sku

      const result = await service.resolve('RawMaterial', 'xyz-not-found', VENUE_ID, makeConfig(), 'update')

      expect(result).toEqual({ matches: 0, candidates: [], exact: false })
    })

    it('should return empty result for unknown entity', async () => {
      const result = await service.resolve('UnknownModel', 'test', VENUE_ID, makeConfig(), 'update')

      expect(result).toEqual({ matches: 0, candidates: [], exact: false })
      expect(mockQueryRaw).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // venueId security
  // -------------------------------------------------------------------------

  describe('venueId isolation', () => {
    it('should pass venueId to every query call', async () => {
      mockQueryRaw
        .mockResolvedValueOnce([]) // exact
        .mockResolvedValueOnce([]) // fuzzy
        .mockResolvedValueOnce([]) // sku

      await service.resolve('RawMaterial', 'carne', VENUE_ID, makeConfig(), 'update')

      // Each call should have venueId as a parameter in the tagged template
      // Prisma.$queryRaw with tagged templates passes params as array
      for (const call of mockQueryRaw.mock.calls) {
        const [strings, ...values] = call
        // strings is the TemplateStringsArray, values are the interpolated params
        expect(values).toContain(VENUE_ID)
      }
    })

    it('should use different venueId when specified', async () => {
      const anotherVenueId = 'venue-other-999'
      mockQueryRaw.mockResolvedValueOnce([{ id: 'rm-99', name: 'Carne' }])

      const result = await service.resolve('RawMaterial', 'Carne', anotherVenueId, makeConfig(), 'update')

      expect(result.matches).toBe(1)
      const [_strings, ...values] = mockQueryRaw.mock.calls[0]
      expect(values).toContain(anotherVenueId)
      expect(values).not.toContain(VENUE_ID)
    })
  })

  // -------------------------------------------------------------------------
  // SKU fallback
  // -------------------------------------------------------------------------

  describe('SKU fallback', () => {
    it('should fall through to SKU lookup when name matches fail', async () => {
      mockQueryRaw
        .mockResolvedValueOnce([]) // exact name
        .mockResolvedValueOnce([]) // fuzzy name
        .mockResolvedValueOnce([{ id: 'rm-sku', name: 'Carne por SKU' }]) // sku

      const result = await service.resolve('RawMaterial', 'CM-001', VENUE_ID, makeConfig(), 'update')

      expect(result.matches).toBe(1)
      expect(result.exact).toBe(false)
      expect(result.resolved!.id).toBe('rm-sku')
      expect(result.resolved!.score).toBe(0.5)
    })

    it('should skip SKU fallback for Supplier (no sku column)', async () => {
      mockQueryRaw
        .mockResolvedValueOnce([]) // exact name
        .mockResolvedValueOnce([]) // fuzzy name
      // No sku call for Supplier

      const result = await service.resolve('Supplier', 'xyz', VENUE_ID, makeConfig())

      expect(result.matches).toBe(0)
      // Only 2 calls: exact + fuzzy (no sku)
      expect(mockQueryRaw).toHaveBeenCalledTimes(2)
    })

    it('should work for Product SKU fallback', async () => {
      mockQueryRaw
        .mockResolvedValueOnce([]) // exact
        .mockResolvedValueOnce([]) // fuzzy
        .mockResolvedValueOnce([{ id: 'prod-sku-1', name: 'Taco al Pastor' }]) // sku

      const result = await service.resolve('Product', 'TAC-001', VENUE_ID, makeConfig(), 'update')

      expect(result.matches).toBe(1)
      expect(result.resolved!.id).toBe('prod-sku-1')
    })
  })

  // -------------------------------------------------------------------------
  // Active/deleted filtering by operation
  // -------------------------------------------------------------------------

  describe('active/deleted filtering by operation', () => {
    it('update operation: query must include active = true AND deletedAt IS NULL', async () => {
      mockQueryRaw.mockResolvedValueOnce([{ id: 'rm-1', name: 'Test' }])

      await service.resolve('RawMaterial', 'Test', VENUE_ID, makeConfig(), 'update')

      // The SQL fragment should contain both active and deletedAt filters
      // We verify via the tagged template's strings array
      const [strings] = mockQueryRaw.mock.calls[0]
      const sqlText = strings.join('?')
      expect(sqlText).toMatch(/active\s*=\s*true/)
      expect(sqlText).toMatch(/"deletedAt"\s+IS\s+NULL/)
    })

    it('delete operation: query must include deletedAt IS NULL but NOT active filter', async () => {
      mockQueryRaw.mockResolvedValueOnce([{ id: 'rm-1', name: 'Test' }])

      await service.resolve('RawMaterial', 'Test', VENUE_ID, makeConfig(), 'delete')

      const [strings] = mockQueryRaw.mock.calls[0]
      const sqlText = strings.join('?')
      expect(sqlText).toMatch(/"deletedAt"\s+IS\s+NULL/)
      expect(sqlText).not.toMatch(/active\s*=\s*true/)
    })

    it('custom operation: query must include active = true AND deletedAt IS NULL', async () => {
      mockQueryRaw.mockResolvedValueOnce([{ id: 'rm-1', name: 'Test' }])

      await service.resolve('RawMaterial', 'Test', VENUE_ID, makeConfig(), 'custom')

      const [strings] = mockQueryRaw.mock.calls[0]
      const sqlText = strings.join('?')
      expect(sqlText).toMatch(/active\s*=\s*true/)
      expect(sqlText).toMatch(/"deletedAt"\s+IS\s+NULL/)
    })

    it('create operation: query has no active or deletedAt filter', async () => {
      mockQueryRaw.mockResolvedValueOnce([{ id: 'rm-1', name: 'Test' }])

      await service.resolve('RawMaterial', 'Test', VENUE_ID, makeConfig(), 'create')

      const [strings] = mockQueryRaw.mock.calls[0]
      const sqlText = strings.join('?')
      expect(sqlText).not.toMatch(/active\s*=\s*true/)
      expect(sqlText).not.toMatch(/"deletedAt"\s+IS\s+NULL/)
    })

    it('no operation: query has no active or deletedAt filter', async () => {
      mockQueryRaw.mockResolvedValueOnce([{ id: 'rm-1', name: 'Test' }])

      await service.resolve('RawMaterial', 'Test', VENUE_ID, makeConfig())

      const [strings] = mockQueryRaw.mock.calls[0]
      const sqlText = strings.join('?')
      expect(sqlText).not.toMatch(/active\s*=\s*true/)
      expect(sqlText).not.toMatch(/"deletedAt"\s+IS\s+NULL/)
    })
  })

  // -------------------------------------------------------------------------
  // Two-hop resolution
  // -------------------------------------------------------------------------

  describe('two-hop resolution', () => {
    it('should resolve via intermediate entity when no direct match and resolveVia is set', async () => {
      const config = makeConfig({
        resolveVia: {
          intermediateEntity: 'RawMaterial',
          intermediateField: 'rawMaterialId',
          linkField: 'rawMaterialId',
        },
      })

      mockQueryRaw
        .mockResolvedValueOnce([]) // exact on Product
        .mockResolvedValueOnce([]) // fuzzy on Product
        .mockResolvedValueOnce([]) // sku on Product
        .mockResolvedValueOnce([{ id: 'rm-int-1', name: 'Carne Molida' }]) // exact on intermediate (RawMaterial)
        .mockResolvedValueOnce([{ id: 'recipe-1', name: 'Receta de Carne' }]) // final link search

      const result = await service.resolve('Product', 'Carne Molida', VENUE_ID, config, 'update')

      expect(result.matches).toBe(1)
      expect(result.resolved!.id).toBe('recipe-1')
      expect(mockQueryRaw).toHaveBeenCalledTimes(5)
    })

    it('should return empty result when intermediate entity not found in two-hop', async () => {
      const config = makeConfig({
        resolveVia: {
          intermediateEntity: 'RawMaterial',
          intermediateField: 'rawMaterialId',
          linkField: 'rawMaterialId',
        },
      })

      mockQueryRaw
        .mockResolvedValueOnce([]) // exact on Product
        .mockResolvedValueOnce([]) // fuzzy on Product
        .mockResolvedValueOnce([]) // sku on Product
        .mockResolvedValueOnce([]) // exact on intermediate → nothing found
        .mockResolvedValueOnce([]) // fuzzy on intermediate → nothing found

      const result = await service.resolve('Product', 'NotFound', VENUE_ID, config, 'update')

      expect(result.matches).toBe(0)
      expect(result.candidates).toHaveLength(0)
    })

    it('should call intermediate query then final query in two-hop', async () => {
      const config = makeConfig({
        resolveVia: {
          intermediateEntity: 'Supplier',
          intermediateField: 'supplierId',
          linkField: 'supplierId',
        },
      })

      mockQueryRaw
        .mockResolvedValueOnce([]) // exact on RawMaterial
        .mockResolvedValueOnce([]) // fuzzy on RawMaterial
        .mockResolvedValueOnce([]) // sku on RawMaterial
        .mockResolvedValueOnce([{ id: 'sup-1', name: 'Proveedor ABC' }]) // intermediate Supplier
        .mockResolvedValueOnce([{ id: 'rm-final-1', name: 'Insumo Final' }]) // final RawMaterial

      const result = await service.resolve('RawMaterial', 'Proveedor ABC', VENUE_ID, config, 'update')

      expect(result.matches).toBe(1)
      expect(result.resolved!.id).toBe('rm-final-1')

      // 4th call is intermediate exact search
      const intermediateCall = mockQueryRaw.mock.calls[3]
      const [intermediateStrings, ...intermediateValues] = intermediateCall
      const intermediateSql = intermediateStrings.join('?')
      expect(intermediateSql).toMatch(/FROM\s+"Supplier"/)
      expect(intermediateValues).toContain('Proveedor ABC')
      expect(intermediateValues).toContain(VENUE_ID)
    })
  })

  // -------------------------------------------------------------------------
  // Regression: no $queryRawUnsafe should be called
  // -------------------------------------------------------------------------

  describe('regression: security', () => {
    it('should never call $queryRawUnsafe', async () => {
      const mockPrisma = prisma as unknown as { $queryRawUnsafe?: jest.Mock }
      mockPrisma.$queryRawUnsafe = jest.fn()

      mockQueryRaw.mockResolvedValueOnce([{ id: 'rm-1', name: 'Carne' }])

      await service.resolve('RawMaterial', 'Carne', VENUE_ID, makeConfig(), 'update')

      expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled()
    })
  })
})
