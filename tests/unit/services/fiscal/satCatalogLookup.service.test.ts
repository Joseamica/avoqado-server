// tests/unit/services/fiscal/satCatalogLookup.service.test.ts
//
// Unit tests for searchSatCatalog — always use injected DI deps (no real HTTP calls).

import { searchSatCatalog, SatCatalogDeps } from '../../../../src/services/fiscal/satCatalogLookup.service'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDeps(overrides: Partial<SatCatalogDeps> = {}): SatCatalogDeps {
  return {
    searchProducts: jest.fn().mockResolvedValue({ data: [] }),
    searchUnits: jest.fn().mockResolvedValue({ data: [] }),
    ...overrides,
  }
}

// ─── Tests: type=product ──────────────────────────────────────────────────────

describe('searchSatCatalog — type=product', () => {
  it('calls searchProducts with q and NOT searchUnits', async () => {
    const deps = makeDeps({
      searchProducts: jest.fn().mockResolvedValue({ data: [{ key: '90101500', description: 'Servicio de restaurante' }] }),
    })

    await searchSatCatalog({ type: 'product', q: 'restaurante' }, deps)

    expect(deps.searchProducts).toHaveBeenCalledWith('restaurante')
    expect(deps.searchUnits).not.toHaveBeenCalled()
  })

  it('normalizes { data: [...] } shape to { results: [{ key, description }] }', async () => {
    const deps = makeDeps({
      searchProducts: jest.fn().mockResolvedValue({
        data: [
          { key: '90101500', description: 'Servicio de restaurante' },
          { key: '01010101', description: 'Genérico' },
        ],
      }),
    })

    const result = await searchSatCatalog({ type: 'product', q: 'servicio' }, deps)

    expect(result).toEqual({
      results: [
        { key: '90101500', description: 'Servicio de restaurante' },
        { key: '01010101', description: 'Genérico' },
      ],
    })
  })

  it('handles bare array response (no { data } wrapper)', async () => {
    const deps = makeDeps({
      searchProducts: jest.fn().mockResolvedValue([{ key: '90101500', description: 'Restaurante' }]),
    })

    const result = await searchSatCatalog({ type: 'product', q: 'res' }, deps)

    expect(result.results).toHaveLength(1)
    expect(result.results[0]).toEqual({ key: '90101500', description: 'Restaurante' })
  })

  it('returns empty { results: [] } when no matches', async () => {
    const deps = makeDeps({
      searchProducts: jest.fn().mockResolvedValue({ data: [] }),
    })

    const result = await searchSatCatalog({ type: 'product', q: 'zzznomatch' }, deps)

    expect(result).toEqual({ results: [] })
  })
})

// ─── Tests: type=unit ─────────────────────────────────────────────────────────

describe('searchSatCatalog — type=unit', () => {
  it('calls searchUnits with q and NOT searchProducts', async () => {
    const deps = makeDeps({
      searchUnits: jest.fn().mockResolvedValue({ data: [{ key: 'E48', name: 'Unidad de servicio' }] }),
    })

    await searchSatCatalog({ type: 'unit', q: 'servicio' }, deps)

    expect(deps.searchUnits).toHaveBeenCalledWith('servicio')
    expect(deps.searchProducts).not.toHaveBeenCalled()
  })

  it('maps `name` field to description for units ({ data } shape)', async () => {
    const deps = makeDeps({
      searchUnits: jest.fn().mockResolvedValue({
        data: [
          { key: 'E48', name: 'Unidad de servicio' },
          { key: 'H87', name: 'Pieza' },
        ],
      }),
    })

    const result = await searchSatCatalog({ type: 'unit', q: 'pieza' }, deps)

    expect(result).toEqual({
      results: [
        { key: 'E48', description: 'Unidad de servicio' },
        { key: 'H87', description: 'Pieza' },
      ],
    })
  })

  it('handles bare array response (no { data } wrapper) for units', async () => {
    const deps = makeDeps({
      searchUnits: jest.fn().mockResolvedValue([{ key: 'H87', name: 'Pieza' }]),
    })

    const result = await searchSatCatalog({ type: 'unit', q: 'p' }, deps)

    expect(result.results).toHaveLength(1)
    expect(result.results[0]).toEqual({ key: 'H87', description: 'Pieza' })
  })

  it('falls back to description field when name is absent on a unit item', async () => {
    const deps = makeDeps({
      searchUnits: jest.fn().mockResolvedValue({ data: [{ key: 'H87', description: 'Pieza (fallback)' }] }),
    })

    const result = await searchSatCatalog({ type: 'unit', q: 'pieza' }, deps)

    expect(result.results[0]).toEqual({ key: 'H87', description: 'Pieza (fallback)' })
  })

  it('returns empty { results: [] } when no unit matches', async () => {
    const deps = makeDeps({
      searchUnits: jest.fn().mockResolvedValue({ data: [] }),
    })

    const result = await searchSatCatalog({ type: 'unit', q: 'zzz' }, deps)

    expect(result).toEqual({ results: [] })
  })
})

// ─── Tests: q optional (picker opened with empty search) ─────────────────────
// Regression: schema used to require q → dropdown open fired ?type=product with
// no q → 400 → picker hung at "Buscando...". Empty q must pass through and hit
// the catalog's default first page.

describe('searchSatCatalog — q omitted (default first page)', () => {
  it('calls searchProducts with undefined q for type=product', async () => {
    const deps = makeDeps({
      searchProducts: jest.fn().mockResolvedValue({ data: [{ key: '01010101', description: 'Genérico' }] }),
    })

    const result = await searchSatCatalog({ type: 'product' }, deps)

    expect(deps.searchProducts).toHaveBeenCalledWith(undefined)
    expect(result.results).toEqual([{ key: '01010101', description: 'Genérico' }])
  })

  it('calls searchUnits with undefined q for type=unit', async () => {
    const deps = makeDeps({
      searchUnits: jest.fn().mockResolvedValue({ data: [{ key: 'H87', name: 'Pieza' }] }),
    })

    const result = await searchSatCatalog({ type: 'unit' }, deps)

    expect(deps.searchUnits).toHaveBeenCalledWith(undefined)
    expect(result.results).toEqual([{ key: 'H87', description: 'Pieza' }])
  })
})

// ─── Tests: schema — q optional, type still required ──────────────────────────

describe('satCatalogSchema — q optional', () => {
  const { satCatalogSchema } = require('../../../../src/schemas/dashboard/cfdi.schema')

  it('accepts a query with type only (no q) — the picker default-open case', () => {
    const parsed = satCatalogSchema.safeParse({ query: { type: 'product' } })
    expect(parsed.success).toBe(true)
  })

  it('still rejects a missing/invalid type', () => {
    expect(satCatalogSchema.safeParse({ query: {} }).success).toBe(false)
    expect(satCatalogSchema.safeParse({ query: { type: 'bogus' } }).success).toBe(false)
  })

  it('still rejects an explicitly empty q', () => {
    expect(satCatalogSchema.safeParse({ query: { type: 'unit', q: '' } }).success).toBe(false)
  })
})

// ─── Tests: error propagation ─────────────────────────────────────────────────

describe('searchSatCatalog — error handling', () => {
  it('propagates errors thrown by searchProducts', async () => {
    const deps = makeDeps({
      searchProducts: jest.fn().mockRejectedValue(new Error('facturapi network timeout')),
    })

    await expect(searchSatCatalog({ type: 'product', q: 'any' }, deps)).rejects.toThrow('facturapi network timeout')
  })

  it('propagates errors thrown by searchUnits', async () => {
    const deps = makeDeps({
      searchUnits: jest.fn().mockRejectedValue(new Error('catalog service unavailable')),
    })

    await expect(searchSatCatalog({ type: 'unit', q: 'any' }, deps)).rejects.toThrow('catalog service unavailable')
  })
})
