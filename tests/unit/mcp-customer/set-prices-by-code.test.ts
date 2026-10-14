import { z } from 'zod'
import { registerCatalogInBulkTools } from '../../../src/mcp/tools/catalogInBulk'
import type { McpScope } from '../../../src/mcp/scope'
import { confirmarPorElCatalogo, filaProducto } from '../../__helpers__/catalogo-en-bloque'
import { conectarPorElCatalogo } from '../../__helpers__/mcp-por-el-catalogo'

// set_prices_by_code (MCP libre): vista previa, huella, candado optimista por producto y bitácora del lote, sin base de datos.
const mockProductFindMany = jest.fn()
const mockRequirePermission = jest.fn()
const mockUpdateProduct = jest.fn()
const mockLogAction = jest.fn()

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    product: { findMany: (...a: unknown[]) => mockProductFindMany(...(a as [])) },
    menuCategory: { findMany: jest.fn() },
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
  createProduct: jest.fn(),
  updateProduct: (...a: unknown[]) => mockUpdateProduct(...(a as [])),
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
const call = (args: Record<string, unknown>) => handlers.get('set_prices_by_code')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)
const actor = { type: 'HUMAN', staffId: 'staff-1', impersonating: false }
/** Un error operativo como los de la app (AppError): su mensaje está escrito para el operador. */
const operativo = (message: string) => Object.assign(new Error(message), { isOperational: true })

const p1 = filaProducto({ id: 'p1', name: 'Vestido Mailen M', sku: 'MAILEN-M', gtin: '8445000000017', price: 1000 })
const p2 = filaProducto({ id: 'p2', name: 'Vestido Mailen L', sku: 'MAILEN-L', gtin: '8445000000024', price: 1200 })

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
  mockUpdateProduct.mockReset()
  mockUpdateProduct.mockImplementation(async (_v: string, id: string, data: { price: number }) => ({ id, price: data.price }))
})

describe('set_prices_by_code', () => {
  it('sin confirm: vista previa actual → nuevo, cuántos ya tenían ese precio y la huella; NO escribe', async () => {
    mockProductFindMany.mockResolvedValueOnce([p1, p2])
    const out = parse(
      await call({
        venueId: 'v1',
        items: [
          { code: '8445000000017', price: 1290.5 },
          { code: 'MAILEN-L', price: 1200 },
          { code: 'NO-EXISTE', price: 10 },
        ],
      }),
    )
    expect(mockRequirePermission).toHaveBeenCalledWith('products:update', 'v1')
    expect(out.requiresConfirmation).toBe(true)
    expect(out.changes).toEqual([{ code: '8445000000017', sku: 'MAILEN-M', name: 'Vestido Mailen M', from: 1000, to: 1290.5 }])
    expect(out.unchanged).toBe(1)
    expect(out.notFound).toEqual(['NO-EXISTE'])
    // El asistente repite el mensaje, no las listas: lo que quedó fuera va contado en el texto.
    expect(out.message).toBe(
      'Esto cambiará el precio de 1 producto(s): lo que paga el cliente, con IVA. Quedaron fuera: sin encontrar 1 (ver esas listas). Muéstrale la lista al operador; con su autorización vuelve a llamar con confirm:true.',
    )
    expect(typeof out.expectedSourceFingerprint).toBe('string')
    expect(mockUpdateProduct).not.toHaveBeenCalled()
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('si nada cambia, contesta ok sin pedir confirmación: cuántos ya tenían ese precio y qué quedó fuera', async () => {
    mockProductFindMany.mockResolvedValueOnce([p2])
    const out = parse(
      await call({
        venueId: 'v1',
        items: [
          { code: 'MAILEN-L', price: 1200 },
          { code: 'NO-EXISTE', price: 5 },
        ],
      }),
    )
    expect(out).toMatchObject({ ok: true, applied: 0, unchanged: 1 })
    expect(out.requiresConfirmation).toBeUndefined()
    expect(out.message).toBe(
      'Los 1 producto(s) encontrados ya tienen ese precio: no hay nada que cambiar. Quedaron fuera: sin encontrar 1 (ver esas listas).',
    )
  })

  it('🔍 si ningún código cae en un producto: ok:false con needsInput (nunca «nada que cambiar») y cuántos quedaron fuera', async () => {
    mockProductFindMany.mockResolvedValueOnce([])
    const out = parse(
      await call({
        venueId: 'v1',
        items: [
          { code: '8 445000 000017', price: 10 },
          { code: 'NO-EXISTE', price: 20 },
        ],
      }),
    )
    expect(out).toMatchObject({ ok: false, needsInput: true, notFound: ['8 445000 000017', 'NO-EXISTE'] })
    expect(out).not.toHaveProperty('applied')
    expect(out.message).toBe(
      'No encontré ninguno de los 2 códigos en este negocio. Quedaron fuera: sin encontrar 2 (ver esas listas). Revisa los códigos (un código de barras va sin espacios) antes de seguir.',
    )
    expect(mockUpdateProduct).not.toHaveBeenCalled()
  })

  it('un producto desactivado sí cambia de precio: sale marcado inactive y el mensaje dice que no se vende hasta activarlo', async () => {
    const apagado = filaProducto({ id: 'p3', name: 'Falda Caye S', sku: 'CAYE-S', price: 500, active: false })
    mockProductFindMany.mockResolvedValue([p1, apagado])
    const items = [
      { code: 'MAILEN-M', price: 1290 },
      { code: 'CAYE-S', price: 650 },
    ]
    const vista = parse(await call({ venueId: 'v1', items }))
    expect(vista.changes).toEqual([
      { code: 'MAILEN-M', sku: 'MAILEN-M', name: 'Vestido Mailen M', from: 1000, to: 1290 },
      { code: 'CAYE-S', sku: 'CAYE-S', name: 'Falda Caye S', from: 500, to: 650, inactive: true },
    ])
    expect(vista.message).toBe(
      'Esto cambiará el precio de 2 producto(s): lo que paga el cliente, con IVA. 1 están desactivados: el precio cambia, pero no se venden hasta activarlos. Muéstrale la lista al operador; con su autorización vuelve a llamar con confirm:true.',
    )
    const out = parse(await call({ venueId: 'v1', items, confirm: true, expectedSourceFingerprint: vista.expectedSourceFingerprint }))
    expect(out.appliedChanges).toEqual([
      { productId: 'p1', sku: 'MAILEN-M', from: 1000, to: 1290 },
      { productId: 'p3', sku: 'CAYE-S', from: 500, to: 650, inactive: true },
    ])
    expect(out.message).toBe('Listo: 2 precio(s) cambiado(s). 1 están desactivados: el precio cambia, pero no se venden hasta activarlos.')
  })

  it('con confirm y la huella: un cambio por producto con el candado optimista, la lista de lo aplicado y UNA bitácora', async () => {
    mockProductFindMany.mockResolvedValue([p1, p2])
    const items = [
      { code: '8445000000017', price: 1290.5 },
      { code: 'MAILEN-L', price: 1350 },
      { code: 'NO-EXISTE', price: 10 },
    ]
    const vista = parse(await call({ venueId: 'v1', items }))
    const out = parse(await call({ venueId: 'v1', items, confirm: true, expectedSourceFingerprint: vista.expectedSourceFingerprint }))
    const aplicado = [
      { productId: 'p1', sku: 'MAILEN-M', from: 1000, to: 1290.5 },
      { productId: 'p2', sku: 'MAILEN-L', from: 1200, to: 1350 },
    ]
    expect(out).toMatchObject({ ok: true, applied: 2, failed: [], notFound: ['NO-EXISTE'] })
    expect(out.message).toBe('Listo: 2 precio(s) cambiado(s). Quedaron fuera: sin encontrar 1 (ver esas listas).')
    expect(out.appliedChanges).toEqual(aplicado)
    expect(mockUpdateProduct).toHaveBeenCalledTimes(2)
    expect(mockUpdateProduct).toHaveBeenCalledWith('v1', 'p1', { price: 1290.5 }, actor, {
      name: 'Vestido Mailen M',
      price: p1.price,
      active: true,
    })
    expect(mockLogAction).toHaveBeenCalledTimes(1)
    expect(mockLogAction.mock.calls[0][0]).toMatchObject({
      staffId: 'staff-1',
      venueId: 'v1',
      action: 'MENU_PRICES_SET_BULK',
      entity: 'Venue',
      entityId: 'v1',
      data: { source: 'customer-mcp', applied: aplicado },
    })
  })

  it('si un precio cambió desde la vista previa (otra huella), no aplica NADA y pide otra vista previa', async () => {
    mockProductFindMany
      .mockResolvedValueOnce([p1])
      .mockResolvedValueOnce([filaProducto({ id: 'p1', name: 'Vestido Mailen M', sku: 'MAILEN-M', gtin: '8445000000017', price: 1100 })])
    const items = [{ code: 'MAILEN-M', price: 1290.5 }]
    const vista = parse(await call({ venueId: 'v1', items }))
    const out = parse(await call({ venueId: 'v1', items, confirm: true, expectedSourceFingerprint: vista.expectedSourceFingerprint }))
    expect(out).toMatchObject({ ok: false, stale: true, needsInput: true })
    expect(mockUpdateProduct).not.toHaveBeenCalled()
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('🔍 si dos códigos cambiaron de producto desde la vista previa (mismos precios), no aplica nada', async () => {
    const a = filaProducto({ id: 'pa', sku: 'A-M', gtin: '7500000000001', price: 100 })
    const b = filaProducto({ id: 'pb', sku: 'B-M', gtin: '7500000000002', price: 200 })
    const aCambiado = filaProducto({ id: 'pa', sku: 'A-M', gtin: '7500000000002', price: 100 })
    const bCambiado = filaProducto({ id: 'pb', sku: 'B-M', gtin: '7500000000001', price: 200 })
    mockProductFindMany.mockResolvedValueOnce([a, b]).mockResolvedValueOnce([aCambiado, bCambiado])
    const items = [
      { code: '7500000000001', price: 150 },
      { code: '7500000000002', price: 250 },
    ]
    const vista = parse(await call({ venueId: 'v1', items }))
    const out = parse(await call({ venueId: 'v1', items, confirm: true, expectedSourceFingerprint: vista.expectedSourceFingerprint }))
    expect(out).toMatchObject({ ok: false, stale: true })
    expect(mockUpdateProduct).not.toHaveBeenCalled()
  })

  it('el segundo producto cambió justo antes de escribirlo: sale en failed y el primero queda aplicado', async () => {
    mockProductFindMany.mockResolvedValue([p1, p2])
    mockUpdateProduct
      .mockResolvedValueOnce({ id: 'p1' })
      .mockRejectedValueOnce(operativo('El producto cambió desde la vista previa. Revisa y confirma de nuevo.'))
    const items = [
      { code: 'MAILEN-M', price: 1290.5 },
      { code: 'MAILEN-L', price: 1350 },
    ]
    const vista = parse(await call({ venueId: 'v1', items }))
    const out = parse(await call({ venueId: 'v1', items, confirm: true, expectedSourceFingerprint: vista.expectedSourceFingerprint }))
    expect(out).toMatchObject({ ok: true, applied: 1 })
    expect(out.message).toBe('Se cambiaron 1; 1 no se pudieron (ver failed).')
    expect(out.failed).toEqual([
      {
        code: 'MAILEN-L',
        sku: 'MAILEN-L',
        name: 'Vestido Mailen L',
        error: 'El producto cambió desde la vista previa. Revisa y confirma de nuevo.',
      },
    ])
  })

  it('un error interno de un renglón no filtra texto de la base a la IA', async () => {
    mockProductFindMany.mockResolvedValue([p1])
    mockUpdateProduct.mockRejectedValueOnce(new Error('Invalid `prisma.product.update()` invocation: column "price"'))
    const items = [{ code: 'MAILEN-M', price: 1290.5 }]
    const vista = parse(await call({ venueId: 'v1', items }))
    const out = parse(await call({ venueId: 'v1', items, confirm: true, expectedSourceFingerprint: vista.expectedSourceFingerprint }))
    expect(out.ok).toBe(false)
    expect(out.failed[0].error).not.toMatch(/prisma|column/i)
  })

  it('🔍 el mismo producto por dos códigos (su barras y su SKU) no se toca, y se dice', async () => {
    mockProductFindMany.mockResolvedValueOnce([p1])
    const out = parse(
      await call({
        venueId: 'v1',
        items: [
          { code: '8445000000017', price: 1290 },
          { code: 'MAILEN-M', price: 1350 },
        ],
      }),
    )
    expect(out).toMatchObject({ ok: true, applied: 0 })
    expect(out.sameProductTwice).toEqual([{ codes: ['8445000000017', 'MAILEN-M'], sku: 'MAILEN-M', name: 'Vestido Mailen M' }])
  })

  it('🔍 un código repetido no se cuela por el otro código del mismo producto', async () => {
    mockProductFindMany.mockResolvedValueOnce([p1])
    const out = parse(
      await call({
        venueId: 'v1',
        items: [
          { code: 'MAILEN-M', price: 150 },
          { code: 'MAILEN-M', price: 200 },
          { code: '8445000000017', price: 250 },
        ],
      }),
    )
    expect(out).toMatchObject({ ok: true, applied: 0 })
    expect(out.duplicateCodes).toEqual(['MAILEN-M'])
    expect(out.sameProductTwice).toEqual([{ codes: ['MAILEN-M', '8445000000017'], sku: 'MAILEN-M', name: 'Vestido Mailen M' }])
  })

  it('un código repetido en la lista no se aplica ni una vez', async () => {
    mockProductFindMany.mockResolvedValueOnce([p1])
    const out = parse(
      await call({
        venueId: 'v1',
        items: [
          { code: 'MAILEN-M', price: 1290 },
          { code: 'MAILEN-M', price: 1350 },
        ],
      }),
    )
    expect(out.applied).toBe(0)
    expect(out.duplicateCodes).toEqual(['MAILEN-M'])
  })

  it('🔍 un precio con más de 2 decimales (de una multiplicación) rechaza la llamada con un mensaje en español', () => {
    const s = z.object(schemas.get('set_prices_by_code')!)
    const r = s.safeParse({ venueId: 'v1', items: [{ code: 'MAILEN-M', price: 1199.915 }] })
    expect(r.success).toBe(false)
    expect(JSON.stringify(r.error?.issues)).toContain('a lo más 2 decimales')
  })

  it('topes del servidor: 300 renglones sí, 301 no; precio 0, negativo o arriba de 99,999,999.99 no', () => {
    const s = z.object(schemas.get('set_prices_by_code')!)
    const renglones = (n: number, price = 10) => Array.from({ length: n }, (_, i) => ({ code: `C${i}`, price }))
    expect(s.safeParse({ venueId: 'v1', items: renglones(300) }).success).toBe(true)
    expect(s.safeParse({ venueId: 'v1', items: renglones(301) }).success).toBe(false)
    for (const price of [0, -5, 100000000]) expect(s.safeParse({ venueId: 'v1', items: renglones(1, price) }).success).toBe(false)
  })
})

describe('set_prices_by_code por el catálogo real (token de dos pasos)', () => {
  it('el token ata la huella: la confirmación con lo firmado aplica', async () => {
    mockProductFindMany.mockResolvedValue([p1])
    const c = await conectarPorElCatalogo(server => registerCatalogInBulkTools(server, scope), scope)
    try {
      const { vista, resultado } = await confirmarPorElCatalogo(c, 'set_prices_by_code', {
        venueId: 'v1',
        items: [{ code: 'MAILEN-M', price: 1290.5 }],
      })
      expect(vista.confirmationArguments.expectedSourceFingerprint).toBe(vista.expectedSourceFingerprint)
      expect(resultado).toMatchObject({ ok: true, applied: 1 })
      expect(mockUpdateProduct).toHaveBeenCalledTimes(1)
    } finally {
      await c.close()
    }
  })

  it('una huella distinta a la firmada no ejecuta', async () => {
    mockProductFindMany.mockResolvedValue([p1])
    const c = await conectarPorElCatalogo(server => registerCatalogInBulkTools(server, scope), scope)
    try {
      const vista = await c.call('set_prices_by_code', { venueId: 'v1', items: [{ code: 'MAILEN-M', price: 1290.5 }] })
      const out = await c.call('set_prices_by_code', {
        ...vista.confirmationArguments,
        expectedSourceFingerprint: 'otra',
        confirm: true,
        confirmationToken: vista.confirmationToken,
      })
      expect(out).toMatchObject({ ok: false, needsInput: true, field: 'confirmationToken' })
      expect(mockUpdateProduct).not.toHaveBeenCalled()
    } finally {
      await c.close()
    }
  })
})
