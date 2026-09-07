// tests/unit/services/fiscal/satCatalogLookup.service.test.ts
//
// Unit tests for searchSatCatalog — always use injected DI deps (no real HTTP calls).

import {
  searchSatCatalog,
  resolveCatalogApiKey,
  defaultKeyDeps,
  SatCatalogUnavailableError,
  SatCatalogDeps,
  SatCatalogKeyDeps,
} from '../../../../src/services/fiscal/satCatalogLookup.service'
import prisma from '../../../../src/utils/prismaClient'
import { decryptProviderKey } from '../../../../src/services/fiscal/fiscalKey.service'
import { env } from '../../../../src/config/env'

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: { fiscalEmisor: { findFirst: jest.fn() } },
}))

jest.mock('../../../../src/services/fiscal/fiscalKey.service', () => ({
  decryptProviderKey: jest.fn(),
}))

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

    await searchSatCatalog({ type: 'product', q: 'restaurante', venueId: 'v1' }, deps)

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

    const result = await searchSatCatalog({ type: 'product', q: 'servicio', venueId: 'v1' }, deps)

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

    const result = await searchSatCatalog({ type: 'product', q: 'res', venueId: 'v1' }, deps)

    expect(result.results).toHaveLength(1)
    expect(result.results[0]).toEqual({ key: '90101500', description: 'Restaurante' })
  })

  it('returns empty { results: [] } when no matches', async () => {
    const deps = makeDeps({
      searchProducts: jest.fn().mockResolvedValue({ data: [] }),
    })

    const result = await searchSatCatalog({ type: 'product', q: 'zzznomatch', venueId: 'v1' }, deps)

    expect(result).toEqual({ results: [] })
  })
})

// ─── Tests: type=unit ─────────────────────────────────────────────────────────

describe('searchSatCatalog — type=unit', () => {
  it('calls searchUnits with q and NOT searchProducts', async () => {
    const deps = makeDeps({
      searchUnits: jest.fn().mockResolvedValue({ data: [{ key: 'E48', name: 'Unidad de servicio' }] }),
    })

    await searchSatCatalog({ type: 'unit', q: 'servicio', venueId: 'v1' }, deps)

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

    const result = await searchSatCatalog({ type: 'unit', q: 'pieza', venueId: 'v1' }, deps)

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

    const result = await searchSatCatalog({ type: 'unit', q: 'p', venueId: 'v1' }, deps)

    expect(result.results).toHaveLength(1)
    expect(result.results[0]).toEqual({ key: 'H87', description: 'Pieza' })
  })

  it('falls back to description field when name is absent on a unit item', async () => {
    const deps = makeDeps({
      searchUnits: jest.fn().mockResolvedValue({ data: [{ key: 'H87', description: 'Pieza (fallback)' }] }),
    })

    const result = await searchSatCatalog({ type: 'unit', q: 'pieza', venueId: 'v1' }, deps)

    expect(result.results[0]).toEqual({ key: 'H87', description: 'Pieza (fallback)' })
  })

  it('returns empty { results: [] } when no unit matches', async () => {
    const deps = makeDeps({
      searchUnits: jest.fn().mockResolvedValue({ data: [] }),
    })

    const result = await searchSatCatalog({ type: 'unit', q: 'zzz', venueId: 'v1' }, deps)

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

    const result = await searchSatCatalog({ type: 'product', venueId: 'v1' }, deps)

    expect(deps.searchProducts).toHaveBeenCalledWith(undefined)
    expect(result.results).toEqual([{ key: '01010101', description: 'Genérico' }])
  })

  it('calls searchUnits with undefined q for type=unit', async () => {
    const deps = makeDeps({
      searchUnits: jest.fn().mockResolvedValue({ data: [{ key: 'H87', name: 'Pieza' }] }),
    })

    const result = await searchSatCatalog({ type: 'unit', venueId: 'v1' }, deps)

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

    await expect(searchSatCatalog({ type: 'product', q: 'any', venueId: 'v1' }, deps)).rejects.toThrow('facturapi network timeout')
  })

  it('propagates errors thrown by searchUnits', async () => {
    const deps = makeDeps({
      searchUnits: jest.fn().mockRejectedValue(new Error('catalog service unavailable')),
    })

    await expect(searchSatCatalog({ type: 'unit', q: 'any', venueId: 'v1' }, deps)).rejects.toThrow('catalog service unavailable')
  })
})

// ─── Tests: resolución de la llave (regresión de producción, 2026-09-07) ──────
//
// El picker de claves SAT respondía 500 «La API key proporcionada no es válida»
// en producción (Testarudo Cafe, OWNER). Causa: el servicio construía el cliente
// con FACTURAPI_USER_KEY, que es la llave de CUENTA (sk_user_) — sirve para crear
// organizaciones y administrar llaves, NO para consultar recursos. Los endpoints
// de catálogo de Facturapi sólo aceptan SecretLiveKey / SecretTestKey, o sea llaves
// de ORGANIZACIÓN. La llave test (sk_test_) también es de organización, así que sí
// autoriza catálogos y sirve de respaldo.

function makeKeyDeps(overrides: Partial<SatCatalogKeyDeps> = {}): SatCatalogKeyDeps {
  return {
    findVenueOrgKeyEnc: jest.fn().mockResolvedValue(null),
    decrypt: jest.fn((enc: string) => `descifrada:${enc}`),
    testKey: jest.fn().mockReturnValue(undefined),
    ...overrides,
  }
}

describe('resolveCatalogApiKey — orden de resolución', () => {
  it('usa la llave de ORGANIZACIÓN del emisor del venue cuando existe', async () => {
    const deps = makeKeyDeps({
      findVenueOrgKeyEnc: jest.fn().mockResolvedValue('ENC_DEL_VENUE'),
      testKey: jest.fn().mockReturnValue('sk_test_de_respaldo'),
    })

    const key = await resolveCatalogApiKey('venue-1', deps)

    expect(key).toBe('descifrada:ENC_DEL_VENUE')
    expect(deps.findVenueOrgKeyEnc).toHaveBeenCalledWith('venue-1')
    expect(deps.testKey).not.toHaveBeenCalled()
  })

  it('cae a la llave de PRUEBAS cuando el venue no tiene emisor FACTURAPI con llave', async () => {
    const deps = makeKeyDeps({
      findVenueOrgKeyEnc: jest.fn().mockResolvedValue(null),
      testKey: jest.fn().mockReturnValue('sk_test_de_respaldo'),
    })

    await expect(resolveCatalogApiKey('venue-1', deps)).resolves.toBe('sk_test_de_respaldo')
  })

  it('cae a la llave de PRUEBAS cuando el descifrado truena (llave de cifrado rotada)', async () => {
    const deps = makeKeyDeps({
      findVenueOrgKeyEnc: jest.fn().mockResolvedValue('ENC_CORRUPTA'),
      decrypt: jest.fn(() => {
        throw new Error('bad decrypt')
      }),
      testKey: jest.fn().mockReturnValue('sk_test_de_respaldo'),
    })

    await expect(resolveCatalogApiKey('venue-1', deps)).resolves.toBe('sk_test_de_respaldo')
  })

  it('sin llave del venue y sin llave de pruebas lanza NO_KEY con un mensaje que dice qué falta', async () => {
    const deps = makeKeyDeps()

    const err = await resolveCatalogApiKey('venue-1', deps).catch(e => e)

    expect(err).toBeInstanceOf(SatCatalogUnavailableError)
    expect(err.reason).toBe('NO_KEY')
    expect(err.message).toMatch(/emisor fiscal/i)
  })

  it('NUNCA devuelve la llave de CUENTA (FACTURAPI_USER_KEY) — los catálogos la rechazan', async () => {
    const anterior = { user: env.FACTURAPI_USER_KEY, test: env.FACTURAPI_TEST_KEY }
    try {
      env.FACTURAPI_USER_KEY = 'sk_user_NO_DEBE_USARSE'
      env.FACTURAPI_TEST_KEY = undefined
      ;(prisma.fiscalEmisor.findFirst as jest.Mock).mockResolvedValue(null)

      // Con las deps REALES: sin emisor y sin llave de pruebas debe FALLAR,
      // nunca caer en la llave de cuenta.
      const err = await resolveCatalogApiKey('venue-1', defaultKeyDeps()).catch(e => e)
      expect(err).toBeInstanceOf(SatCatalogUnavailableError)
      expect(err.reason).toBe('NO_KEY')
      expect(String(err.message)).not.toContain('sk_user_')

      // Y con llave de pruebas disponible, gana la de pruebas (de organización).
      env.FACTURAPI_TEST_KEY = 'sk_test_de_respaldo'
      await expect(resolveCatalogApiKey('venue-1', defaultKeyDeps())).resolves.toBe('sk_test_de_respaldo')
    } finally {
      env.FACTURAPI_USER_KEY = anterior.user
      env.FACTURAPI_TEST_KEY = anterior.test
    }
  })
})

describe('defaultKeyDeps — FORMA de la consulta del emisor', () => {
  it('pide el emisor FACTURAPI del venue QUE YA TIENE llave, el más antiguo', async () => {
    ;(prisma.fiscalEmisor.findFirst as jest.Mock).mockResolvedValue({ providerKeyEnc: 'ENC' })

    await defaultKeyDeps().findVenueOrgKeyEnc('venue-1')

    expect(prisma.fiscalEmisor.findFirst).toHaveBeenCalledWith({
      where: { venueId: 'venue-1', provider: 'FACTURAPI', providerKeyEnc: { not: null } },
      orderBy: { createdAt: 'asc' },
      select: { providerKeyEnc: true },
    })
  })

  it('devuelve null cuando el venue no tiene emisor FACTURAPI con llave', async () => {
    ;(prisma.fiscalEmisor.findFirst as jest.Mock).mockResolvedValue(null)

    await expect(defaultKeyDeps().findVenueOrgKeyEnc('venue-1')).resolves.toBeNull()
  })

  it('descifra con el MISMO helper que usa el resto del carril fiscal', () => {
    ;(decryptProviderKey as jest.Mock).mockReturnValue('sk_live_org')

    expect(defaultKeyDeps().decrypt('ENC')).toBe('sk_live_org')
    expect(decryptProviderKey).toHaveBeenCalledWith('ENC')
  })
})

// ─── Tests: el fallo del proveedor sale TIPADO, no adivinado por su texto ─────
//
// El 500 de producción salió porque el controlador clasificaba por expresión
// regular sobre el mensaje (/facturapi|catalog/i) y «La API key proporcionada no
// es válida» no la casa. La clasificación vive ahora en el servicio, que es quien
// sabe a quién llamó.

describe('searchSatCatalog — clasifica los fallos del proveedor', () => {
  it('envuelve el rechazo de llave de Facturapi como PROVIDER_ERROR, conservando el mensaje original', async () => {
    const deps = makeDeps({
      searchProducts: jest.fn().mockRejectedValue(new Error('La API key proporcionada no es válida')),
    })

    const err = await searchSatCatalog({ type: 'product', q: 'cafe', venueId: 'v1' }, deps).catch(e => e)

    expect(err).toBeInstanceOf(SatCatalogUnavailableError)
    expect(err.reason).toBe('PROVIDER_ERROR')
    expect(err.message).toContain('La API key proporcionada no es válida')
  })

  it('envuelve también los fallos de unidades', async () => {
    const deps = makeDeps({
      searchUnits: jest.fn().mockRejectedValue(new Error('socket hang up')),
    })

    const err = await searchSatCatalog({ type: 'unit', q: 'pieza', venueId: 'v1' }, deps).catch(e => e)

    expect(err).toBeInstanceOf(SatCatalogUnavailableError)
    expect(err.reason).toBe('PROVIDER_ERROR')
  })
})

// ─── Guarda estática ──────────────────────────────────────────────────────────

describe('guarda: el catálogo no puede volver a la llave de cuenta', () => {
  it('el servicio NO menciona FACTURAPI_USER_KEY', () => {
    const fuente = require('fs').readFileSync(
      require('path').join(__dirname, '../../../../src/services/fiscal/satCatalogLookup.service.ts'),
      'utf8',
    )

    // Aparece sólo en el comentario que explica por qué NO se usa; nunca leída.
    const lineasQueLaLeen = fuente
      .split('\n')
      .filter((l: string) => l.includes('FACTURAPI_USER_KEY') && !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'))

    expect(lineasQueLaLeen).toEqual([])
  })
})
