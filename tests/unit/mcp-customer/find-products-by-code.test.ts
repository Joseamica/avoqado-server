import { z } from 'zod'
import { limpiarCodigo, registerCatalogInBulkTools, resolverCodigos } from '../../../src/mcp/tools/catalogInBulk'
import type { McpScope } from '../../../src/mcp/scope'
import { filaProducto } from '../../__helpers__/catalogo-en-bloque'

// Catálogo en bloque (MCP libre): cómo se reconoce un código y `find_products_by_code`, sin base de datos.
const mockProductFindMany = jest.fn()
const mockRequirePermission = jest.fn()
const mockTienePermiso = jest.fn()
const mockPlanGate = jest.fn()

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    product: { findMany: (...a: unknown[]) => mockProductFindMany(...(a as [])) },
    menuCategory: { findMany: jest.fn() },
    shopifyVariantLink: { findMany: jest.fn() },
    inventory: { findMany: jest.fn() },
  },
}))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => ({ venueId: { in: [v] } }),
    requirePermission: (...a: unknown[]) => mockRequirePermission(...(a as [])),
    tienePermiso: (...a: unknown[]) => mockTienePermiso(...(a as [])),
  }),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockPlanGate(...(a as [])) }))
jest.mock('@/services/access/basePlan.service', () => ({
  venueHasFeatureAccess: jest.fn(async () => true),
  venuesWithFeatureAccess: jest.fn(async (ids: string[]) => ids),
}))
jest.mock('@/services/dashboard/product.dashboard.service', () => ({ createProduct: jest.fn(), updateProduct: jest.fn() }))
jest.mock('@/services/mobile/inventory.mobile.service', () => ({
  createStockCount: jest.fn(),
  updateStockCount: jest.fn(),
  confirmStockCount: jest.fn(),
  cancelStockCount: jest.fn(),
}))

type Handler = (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>
const handlers = new Map<string, Handler>()
const schemas = new Map<string, Record<string, z.ZodTypeAny>>()
const scope = { staffId: 'staff-1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('find_products_by_code')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerCatalogInBulkTools(
    {
      tool: (...a: unknown[]) => {
        handlers.set(a[0] as string, a[a.length - 1] as Handler)
        schemas.set(a[0] as string, a[2] as Record<string, z.ZodTypeAny>)
      },
    } as never,
    scope,
  )
})
beforeEach(() => {
  jest.clearAllMocks()
  mockTienePermiso.mockReturnValue(true)
  mockPlanGate.mockResolvedValue(null)
})

describe('resolverCodigos', () => {
  const mailen = filaProducto({ id: 'p1', sku: 'MAILEN-M', gtin: '8445000000017' })
  const duenas = filaProducto({ id: 'p2', sku: 'DUENAS-M' })

  it('encuentra por código de barras, por SKU y por el SKU sin acentos', () => {
    const r = resolverCodigos(['8445000000017', 'MAILEN-M', 'DUEÑAS-M'], [mailen, duenas])
    expect(r.found.map(f => [f.code, f.matchedBy, f.product.id])).toEqual([
      ['8445000000017', 'barcode', 'p1'],
      ['MAILEN-M', 'sku', 'p1'],
      ['DUEÑAS-M', 'sku_normalizado', 'p2'],
    ])
    expect(r.notFound).toEqual([])
  })

  it('un código que es el SKU de uno y el código de barras de otro es ambiguo: no elige ninguno', () => {
    const a = filaProducto({ id: 'pa', sku: '7501000000011' })
    const b = filaProducto({ id: 'pb', sku: 'OTRO', gtin: '7501000000011' })
    const r = resolverCodigos(['7501000000011'], [a, b])
    expect(r.found).toEqual([])
    expect(r.ambiguous).toEqual([
      {
        code: '7501000000011',
        candidates: expect.arrayContaining([expect.objectContaining({ sku: '7501000000011' }), expect.objectContaining({ sku: 'OTRO' })]),
      },
    ])
  })

  it('un código que sólo cae en un archivado sale en archived; si también cae en uno vivo, gana el vivo', () => {
    const archivado = filaProducto({ id: 'px', sku: 'VIEJO-M', deletedAt: new Date('2026-09-01') })
    expect(resolverCodigos(['VIEJO-M'], [archivado]).archived).toEqual([{ code: 'VIEJO-M', sku: 'VIEJO-M', name: archivado.name }])
    const vivo = filaProducto({ id: 'pv', sku: 'NUEVO-M', gtin: 'VIEJO-M' })
    expect(resolverCodigos(['VIEJO-M'], [archivado, vivo]).found.map(f => f.product.id)).toEqual(['pv'])
  })

  it('un código repetido sale una vez en found y una vez en duplicateCodes', () => {
    const r = resolverCodigos(['MAILEN-M', 'MAILEN-M', 'MAILEN-M'], [mailen])
    expect(r.found).toHaveLength(1)
    expect(r.duplicateCodes).toEqual(['MAILEN-M'])
  })

  it('el mismo producto por su código de barras y su SKU a la vez no es ambiguo', () => {
    const igual = filaProducto({ id: 'pi', sku: '8445000000055', gtin: '8445000000055' })
    expect(resolverCodigos(['8445000000055'], [igual]).found.map(f => [f.product.id, f.matchedBy])).toEqual([['pi', 'barcode']])
  })

  it('🔍 un código de barras al que se le cayó el cero inicial no se parece a nada: notFound, nunca otro producto', () => {
    const r = resolverCodigos(['845000000017'], [filaProducto({ id: 'pz', sku: 'CERO-M', gtin: '0845000000017' })])
    expect(r.notFound).toEqual(['845000000017'])
    expect(r.found).toEqual([])
  })
})

describe('limpiarCodigo', () => {
  it('🔍 quita los espacios y el apóstrofo de «texto» que deja Excel', () => {
    expect(limpiarCodigo("  '8445000000017 ")).toBe('8445000000017')
    expect(limpiarCodigo('MAILEN-M')).toBe('MAILEN-M')
  })
})

describe('find_products_by_code', () => {
  it('UNA consulta acotada por código de barras o SKU (con el normalizado), sin filtrar archivados', async () => {
    mockProductFindMany.mockResolvedValueOnce([])
    await call({ venueId: 'v1', codes: ['8445000000017', 'DUEÑAS-M'] })
    expect(mockRequirePermission).toHaveBeenCalledWith('menu:read', 'v1')
    expect(mockProductFindMany).toHaveBeenCalledTimes(1)
    const arg = mockProductFindMany.mock.calls[0][0]
    expect(arg.take).toBe(6)
    expect(arg.where.venueId).toEqual({ in: ['v1'] })
    expect(arg.where.deletedAt).toBeUndefined()
    expect(arg.where.OR[0]).toEqual({ gtin: { in: ['8445000000017', 'DUEÑAS-M'] } })
    expect(arg.where.OR[1].sku.in).toEqual(expect.arrayContaining(['8445000000017', 'DUEÑAS-M', 'DUENAS-M']))
  })

  it('devuelve cada producto con su precio en pesos, categoría y existencias, y los totales', async () => {
    mockProductFindMany.mockResolvedValueOnce([
      filaProducto({ id: 'p1', name: 'Vestido Mailen M', sku: 'MAILEN-M', gtin: '8445000000017', price: 1290.5, stock: 3 }),
      filaProducto({ id: 'p2', sku: 'RECETA-1', inventoryMethod: 'RECIPE' }),
    ])
    const out = parse(await call({ venueId: 'v1', codes: ['8445000000017', 'RECETA-1', 'NO-EXISTE'] }))
    expect(out.ok).toBe(true)
    expect(out.totals).toEqual({ requested: 3, found: 2, notFound: 1, ambiguous: 0, archived: 0 })
    expect(out.found[0]).toEqual({
      code: '8445000000017',
      matchedBy: 'barcode',
      productId: 'p1',
      sku: 'MAILEN-M',
      barcode: '8445000000017',
      name: 'Vestido Mailen M',
      category: 'Vestidos',
      price: 1290.5,
      active: true,
      stock: 3,
    })
    expect(out.found[1].stock).toBeNull()
    expect(out.notFound).toEqual(['NO-EXISTE'])
  })

  it('sin el permiso de ver inventario no manda existencias, y lo dice', async () => {
    mockTienePermiso.mockReturnValue(false)
    mockProductFindMany.mockResolvedValueOnce([filaProducto({ sku: 'MAILEN-M', stock: 3 })])
    const out = parse(await call({ venueId: 'v1', codes: ['MAILEN-M'] }))
    expect(mockTienePermiso).toHaveBeenCalledWith('inventory:read', 'v1')
    expect(mockPlanGate).not.toHaveBeenCalled()
    expect(out.found[0]).not.toHaveProperty('stock')
    expect(out.stockHidden).toContain('inventory:read')
  })

  it('las existencias por pieza no piden el plan de inventario (decisión del 29-sep)', async () => {
    mockPlanGate.mockResolvedValue(
      'El control de inventario no está incluido en el plan actual de este local (requiere INVENTORY_TRACKING).',
    )
    mockProductFindMany.mockResolvedValueOnce([filaProducto({ id: 'p1', sku: 'MAILEN-M', stock: 3 })])
    const out = parse(await call({ venueId: 'v1', codes: ['MAILEN-M'] }))
    expect(out.found[0].stock).toBe(3)
    expect(out).not.toHaveProperty('stockHidden')
    expect(mockPlanGate).not.toHaveBeenCalled()
  })

  it('🔍 un código pegado desde Excel (espacios y apóstrofo) se encuentra igual', async () => {
    mockProductFindMany.mockResolvedValueOnce([filaProducto({ sku: 'MAILEN-M', gtin: '8445000000017' })])
    const out = parse(await call({ venueId: 'v1', codes: ["'8445000000017 "] }))
    expect(out.found[0]).toMatchObject({ code: '8445000000017', matchedBy: 'barcode' })
  })

  it('el tope lo pone el servidor: 500 códigos sí, 501 no, y un código vacío no', () => {
    const s = z.object(schemas.get('find_products_by_code')!)
    const codigos = (n: number) => Array.from({ length: n }, (_, i) => `C${i}`)
    expect(s.safeParse({ venueId: 'v1', codes: codigos(500) }).success).toBe(true)
    expect(s.safeParse({ venueId: 'v1', codes: codigos(501) }).success).toBe(false)
    expect(s.safeParse({ venueId: 'v1', codes: ['   '] }).success).toBe(false)
  })
})
