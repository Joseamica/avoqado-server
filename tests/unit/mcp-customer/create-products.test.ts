import { z } from 'zod'
import { registerCatalogInBulkTools } from '../../../src/mcp/tools/catalogInBulk'
import type { McpScope } from '../../../src/mcp/scope'
import { SKU_REGEX } from '../../../src/schemas/dashboard/menu.schema'
import { confirmarPorElCatalogo } from '../../__helpers__/catalogo-en-bloque'
import { conectarPorElCatalogo } from '../../__helpers__/mcp-por-el-catalogo'

// create_products (MCP libre): revisión de la lista, altas una por una con el servicio de siempre y bitácora del lote.
const mockProductFindMany = jest.fn()
const mockCategoryFindMany = jest.fn()
const mockRequirePermission = jest.fn()
const mockCreateProduct = jest.fn()
const mockLogAction = jest.fn()

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    product: { findMany: (...a: unknown[]) => mockProductFindMany(...(a as [])) },
    menuCategory: { findMany: (...a: unknown[]) => mockCategoryFindMany(...(a as [])) },
    shopifyVariantLink: { findMany: jest.fn() },
    stockCountItem: { findMany: jest.fn() },
    inventoryMovement: { findMany: jest.fn() },
  },
}))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => ({ venueId: { in: [v] } }),
    requirePermission: (...a: unknown[]) => mockRequirePermission(...(a as [])),
    tienePermiso: () => true,
  }),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: (...a: unknown[]) => mockLogAction(...(a as [])) }))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))
jest.mock('@/services/access/basePlan.service', () => ({
  venueHasFeatureAccess: jest.fn(async () => true),
  venuesWithFeatureAccess: jest.fn(async (ids: string[]) => ids),
}))
jest.mock('@/services/dashboard/product.dashboard.service', () => ({
  createProduct: (...a: unknown[]) => mockCreateProduct(...(a as [])),
  updateProduct: jest.fn(),
}))
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
const call = (args: Record<string, unknown>) => handlers.get('create_products')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

const vestidos = { id: 'cat-1', name: 'Vestidos' }
// La consulta por nombres lleva OR ⇒ las categorías que coinciden; la de disponibles (sin OR) ⇒ las activas.
const categorias = (porNombre: Array<{ id: string; name: string }>, disponibles = [{ name: 'Faldas' }, { name: 'Vestidos' }]) =>
  mockCategoryFindMany.mockImplementation(async (arg: { where: { OR?: unknown } }) => (arg.where.OR ? porNombre : disponibles))
const alta = (o: Record<string, unknown> = {}) => ({ name: 'Vestido Mailen MEX - M', price: 1290, category: 'Vestidos', ...o })
const YA_EXISTEN =
  'Todos los productos de esta lista ya existen (mismo SKU o código de barras): no hay nada que crear. Si los creaste en una llamada anterior, ya quedaron.'

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
  mockProductFindMany.mockReset() // un valor encolado que una prueba no gastó no debe pasar a la siguiente
  mockProductFindMany.mockResolvedValue([])
  mockCreateProduct.mockReset()
  mockCreateProduct.mockImplementation(async (_v: string, dto: { sku: string }) => ({ id: `nuevo-${dto.sku}` }))
  categorias([vestidos])
})

describe('create_products', () => {
  it('vista previa: los renglones listos y los que tienen problema, con las categorías disponibles; NO crea', async () => {
    mockProductFindMany.mockResolvedValueOnce([
      { sku: 'USADO-M', gtin: null, name: 'Blusa Vieja', deletedAt: null },
      { sku: 'ARCH-1', gtin: '8445000000099', name: 'Falda Caye', deletedAt: new Date('2026-09-01') },
    ])
    const out = parse(
      await call({
        venueId: 'v1',
        items: [
          alta({ category: 'vestidos', sku: 'MAILEN-MEX-M', barcode: '8445000000031' }),
          alta({ name: 'Blusa', category: 'Blusas' }),
          alta({ name: 'Top Habana', sku: 'HABANA-MÉX' }),
          alta({ name: 'Otra blusa', sku: 'USADO-M' }),
          alta({ name: 'Con código archivado', sku: 'NUEVO-1', barcode: '8445000000099' }),
        ],
      }),
    )
    expect(mockRequirePermission).toHaveBeenCalledWith('products:create', 'v1')
    expect(out.requiresConfirmation).toBe(true)
    expect(out.ready).toEqual([
      {
        row: 1,
        name: 'Vestido Mailen MEX - M',
        price: 1290,
        category: 'Vestidos',
        sku: 'MAILEN-MEX-M',
        barcode: '8445000000031',
        trackStock: true,
      },
    ])
    expect(out.invalid.map((i: { row: number; problem: string }) => [i.row, i.problem])).toEqual([
      [2, 'CATEGORIA_NO_EXISTE'],
      [3, 'SKU_INVALIDO'],
      [4, 'SKU_YA_USADO'],
      [5, 'CODIGO_YA_USADO'],
    ])
    expect(out.invalid[1].suggestion).toBe('HABANA-MEX')
    expect(out.invalid[3].detail).toContain('(archivado)')
    expect(out.availableCategories).toEqual(['Faldas', 'Vestidos'])
    expect(mockCreateProduct).not.toHaveBeenCalled()
  })

  it('un SKU o un código que viene dos veces en la lista: ninguno de esos renglones se crea', async () => {
    const out = parse(
      await call({
        venueId: 'v1',
        items: [
          alta({ sku: 'DOBLE-M' }),
          alta({ sku: 'DOBLE-M' }),
          alta({ name: 'Uno', sku: 'UNO-1', barcode: '8445000000062' }),
          alta({ name: 'Dos', sku: 'DOS-1', barcode: '8445000000062' }),
        ],
      }),
    )
    expect(out.invalid.map((i: { problem: string }) => i.problem)).toEqual([
      'SKU_REPETIDO_EN_LA_LISTA',
      'SKU_REPETIDO_EN_LA_LISTA',
      'CODIGO_REPETIDO_EN_LA_LISTA',
      'CODIGO_REPETIDO_EN_LA_LISTA',
    ])
    expect(out).toMatchObject({ ok: false, created: 0 })
    expect(out.requiresConfirmation).toBeUndefined()
  })

  it('dos categorías con el mismo nombre: no elige una', async () => {
    categorias([vestidos, { id: 'cat-2', name: 'vestidos' }])
    const out = parse(await call({ venueId: 'v1', items: [alta({ sku: 'A-M' })] }))
    expect(out.invalid[0].problem).toBe('CATEGORIA_REPETIDA')
  })

  it('🔍 con más categorías con esos nombres que el tope, no resuelve ninguna y no crea nada', async () => {
    categorias(Array.from({ length: 6 }, (_, i) => ({ id: `cat-${i}`, name: 'Vestidos' })))
    const out = parse(await call({ venueId: 'v1', items: [alta({ sku: 'A-M' })] }))
    expect(out.ok).toBe(false)
    expect(out.error).toContain('demasiadas categorías')
    expect(mockCategoryFindMany.mock.calls[0][0].take).toBe(6)
    expect(mockCreateProduct).not.toHaveBeenCalled()
  })

  it('con confirm: crea los listos con su código de barras e inventario por pieza en 0, y UNA bitácora del lote', async () => {
    const items = [alta({ sku: 'MAILEN-MEX-M', barcode: '8445000000031' }), alta({ name: 'Cinturón Lia', sku: 'LIA-U', trackStock: false })]
    const vista = parse(await call({ venueId: 'v1', items }))
    const out = parse(await call({ venueId: 'v1', items, confirm: true, expectedSourceFingerprint: vista.expectedSourceFingerprint }))
    expect(out).toMatchObject({ ok: true, created: 2, failed: [], invalid: [] })
    expect(mockCreateProduct).toHaveBeenNthCalledWith(
      1,
      'v1',
      {
        name: 'Vestido Mailen MEX - M',
        price: 1290,
        type: 'REGULAR',
        sku: 'MAILEN-MEX-M',
        categoryId: 'cat-1',
        gtin: '8445000000031',
        trackInventory: true,
        inventoryMethod: 'QUANTITY',
      },
      { type: 'HUMAN', staffId: 'staff-1', impersonating: false },
    )
    expect(mockCreateProduct.mock.calls[1][1]).toEqual({
      name: 'Cinturón Lia',
      price: 1290,
      type: 'REGULAR',
      sku: 'LIA-U',
      categoryId: 'cat-1',
    })
    expect(out.products.map((p: { sku: string }) => p.sku)).toEqual(['MAILEN-MEX-M', 'LIA-U'])
    expect(mockLogAction).toHaveBeenCalledTimes(1)
    expect(mockLogAction.mock.calls[0][0]).toMatchObject({
      action: 'PRODUCTS_CREATED_BULK',
      entity: 'Venue',
      entityId: 'v1',
      data: { source: 'customer-mcp' },
    })
  })

  it('sin SKU: el SKU sale del nombre, se ve en la vista previa, es estable y es el mismo que se crea', async () => {
    const items = [alta({ name: 'Vestido Mailen MEX - M' }), alta({ name: 'Vestido Mailen MEX - L' })]
    const vista = parse(await call({ venueId: 'v1', items }))
    const [a, b] = vista.ready.map((r: { sku: string }) => r.sku)
    expect(a).not.toBe(b)
    expect(a).toMatch(SKU_REGEX)
    expect(b).toMatch(SKU_REGEX)
    // Inicio legible del nombre + 8 caracteres de su huella (con 6, dos nombres distintos chocaban más fácil).
    expect(a).toMatch(/^[A-Z0-9]{1,8}-[0-9A-F]{8}$/)
    expect(vista.ready[0].skuGenerated).toBe(true)
    // La misma lista da los mismos SKU: así repetirla los encuentra ocupados.
    expect(parse(await call({ venueId: 'v1', items })).ready.map((r: { sku: string }) => r.sku)).toEqual([a, b])
    await call({ venueId: 'v1', items, confirm: true, expectedSourceFingerprint: vista.expectedSourceFingerprint })
    expect(mockCreateProduct.mock.calls.map(c => (c[1] as { sku: string }).sku)).toEqual([a, b])
  })

  it('🔍 dos renglones sin SKU con el mismo nombre no se crean (no sé cuál es cuál)', async () => {
    const out = parse(await call({ venueId: 'v1', items: [alta({ name: 'Blusa Lino' }), alta({ name: 'blusa  lino ' })] }))
    expect(out.invalid.map((i: { problem: string }) => i.problem)).toEqual(['SKU_REPETIDO_EN_LA_LISTA', 'SKU_REPETIDO_EN_LA_LISTA'])
    expect(out).toMatchObject({ ok: false, created: 0 })
  })

  it('🔍 repetir el alta sin SKU ni código no crea otro producto', async () => {
    const items = [alta({ name: 'Blusa Lino' })]
    const vista = parse(await call({ venueId: 'v1', items }))
    const confirmar = { venueId: 'v1', items, confirm: true, expectedSourceFingerprint: vista.expectedSourceFingerprint }
    expect(parse(await call(confirmar))).toMatchObject({ ok: true, created: 1 })
    // La segunda vez (p. ej. la respuesta de la primera se perdió), el SKU que sale del nombre ya lo ocupa el producto recién creado:
    // no es un error, ya quedó.
    mockProductFindMany.mockResolvedValueOnce([{ sku: vista.ready[0].sku, gtin: null, name: 'Blusa Lino', deletedAt: null }])
    const otra = parse(await call(confirmar))
    expect(otra).toEqual({
      ok: true,
      created: 0,
      invalid: [expect.objectContaining({ row: 1, problem: 'SKU_YA_USADO' })],
      message: YA_EXISTEN,
    })
    expect(mockCreateProduct).toHaveBeenCalledTimes(1)
  })

  it('🔍 si TODOS los renglones ya existen (mismo SKU o mismo código de barras): ok, no hay nada que crear', async () => {
    mockProductFindMany.mockResolvedValueOnce([
      { sku: 'A-M', gtin: null, name: 'Vestido A', deletedAt: null },
      { sku: 'OTRO-1', gtin: '8445000000031', name: 'Vestido B', deletedAt: null },
    ])
    const out = parse(
      await call({
        venueId: 'v1',
        items: [alta({ sku: 'A-M' }), alta({ name: 'Vestido B', sku: 'B-M', barcode: '8445000000031' })],
      }),
    )
    expect(out).toEqual({
      ok: true,
      created: 0,
      invalid: [
        expect.objectContaining({ row: 1, problem: 'SKU_YA_USADO' }),
        expect.objectContaining({ row: 2, problem: 'CODIGO_YA_USADO' }),
      ],
      message: YA_EXISTEN,
    })
    expect(mockCreateProduct).not.toHaveBeenCalled()
  })

  it('si alguno tiene otro problema (una categoría que no existe), sigue siendo un error: corrige la lista', async () => {
    mockProductFindMany.mockResolvedValueOnce([{ sku: 'A-M', gtin: null, name: 'Vestido A', deletedAt: null }])
    const out = parse(await call({ venueId: 'v1', items: [alta({ sku: 'A-M' }), alta({ name: 'Blusa', sku: 'B-M', category: 'Blusas' })] }))
    expect(out).toMatchObject({
      ok: false,
      created: 0,
      error: 'Ningún renglón está listo para crearse: corrige los problemas de la lista.',
    })
  })

  it('un SKU que otro ocupó después de la vista previa (P2002) se reporta y los demás se crean', async () => {
    mockCreateProduct.mockRejectedValueOnce(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }))
    const items = [alta({ sku: 'A-M' }), alta({ sku: 'B-M' })]
    const vista = parse(await call({ venueId: 'v1', items }))
    const out = parse(await call({ venueId: 'v1', items, confirm: true, expectedSourceFingerprint: vista.expectedSourceFingerprint }))
    expect(out.created).toBe(1)
    expect(out.failed).toEqual([{ row: 1, name: 'Vestido Mailen MEX - M', error: expect.stringContaining('ya lo usa otro producto') }])
  })

  it('catálogo maestro: CATALOG_GOVERNANCE_REQUIRED se dice tal cual y no se intenta ningún otro', async () => {
    mockCreateProduct.mockRejectedValueOnce(
      Object.assign(new Error('Este producto debe crearse o activarse desde el Catálogo maestro.'), {
        code: 'CATALOG_GOVERNANCE_REQUIRED',
        isOperational: true,
      }),
    )
    const items = [alta({ sku: 'A-M' }), alta({ sku: 'B-M' })]
    const vista = parse(await call({ venueId: 'v1', items }))
    const out = parse(await call({ venueId: 'v1', items, confirm: true, expectedSourceFingerprint: vista.expectedSourceFingerprint }))
    expect(mockCreateProduct).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({
      ok: false,
      created: 0,
      governanceRequired: true,
      error: 'Este producto debe crearse o activarse desde el Catálogo maestro.',
    })
  })

  it('si un SKU se ocupó desde la vista previa, no crea NADA y pide otra vista previa', async () => {
    const items = [alta({ sku: 'A-M' }), alta({ sku: 'B-M' })]
    const vista = parse(await call({ venueId: 'v1', items }))
    mockProductFindMany.mockResolvedValueOnce([{ sku: 'B-M', gtin: null, name: 'Otro', deletedAt: null }])
    const out = parse(await call({ venueId: 'v1', items, confirm: true, expectedSourceFingerprint: vista.expectedSourceFingerprint }))
    expect(out).toMatchObject({ ok: false, stale: true })
    expect(mockCreateProduct).not.toHaveBeenCalled()
  })

  it('topes: 100 renglones sí, 101 no; código de barras con espacios o de más de 14 caracteres no', () => {
    const s = z.object(schemas.get('create_products')!)
    const renglones = (n: number) => Array.from({ length: n }, (_, i) => alta({ sku: `S-${i}` }))
    expect(s.safeParse({ venueId: 'v1', items: renglones(100) }).success).toBe(true)
    expect(s.safeParse({ venueId: 'v1', items: renglones(101) }).success).toBe(false)
    expect(s.safeParse({ venueId: 'v1', items: [alta({ barcode: '8445 0000' })] }).success).toBe(false)
    expect(s.safeParse({ venueId: 'v1', items: [alta({ barcode: '844500000000001' })] }).success).toBe(false)
  })
})

describe('create_products por el catálogo real', () => {
  it('el token ata la huella y la confirmación con lo firmado crea', async () => {
    const c = await conectarPorElCatalogo(server => registerCatalogInBulkTools(server, scope), scope)
    try {
      const { vista, resultado } = await confirmarPorElCatalogo(c, 'create_products', { venueId: 'v1', items: [alta({ sku: 'A-M' })] })
      expect(vista.confirmationArguments.expectedSourceFingerprint).toBe(vista.expectedSourceFingerprint)
      expect(resultado).toMatchObject({ ok: true, created: 1 })
    } finally {
      await c.close()
    }
  })
})
