import { z } from 'zod'
import { Prisma } from '@prisma/client'
import logger from '@/config/logger' // globally mocked in tests/__helpers__/setup.ts
import { registerCatalogInBulkTools } from '../../../src/mcp/tools/catalogInBulk'
import type { McpScope } from '../../../src/mcp/scope'
import { confirmarPorElCatalogo, filaProducto } from '../../__helpers__/catalogo-en-bloque'
import { conectarPorElCatalogo } from '../../__helpers__/mcp-por-el-catalogo'

// set_stock_by_code (MCP libre): la carga de existencias es un conteo del POS (crear → llenar → confirmar) y la respuesta sale de lo
// que el conteo GUARDÓ (líneas y movimientos), sin base de datos.
const mockProductFindMany = jest.fn()
const mockLinkFindMany = jest.fn()
const mockLineFindMany = jest.fn()
const mockMovementFindMany = jest.fn()
const mockRequirePermission = jest.fn()
const mockPlanGate = jest.fn()
const mockLogAction = jest.fn()
const mockCreateCount = jest.fn()
const mockUpdateCount = jest.fn()
const mockConfirmCount = jest.fn()
const mockCancelCount = jest.fn()

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    product: { findMany: (...a: unknown[]) => mockProductFindMany(...(a as [])) },
    menuCategory: { findMany: jest.fn() },
    shopifyVariantLink: { findMany: (...a: unknown[]) => mockLinkFindMany(...(a as [])) },
    stockCountItem: { findMany: (...a: unknown[]) => mockLineFindMany(...(a as [])) },
    inventoryMovement: { findMany: (...a: unknown[]) => mockMovementFindMany(...(a as [])) },
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
jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockPlanGate(...(a as [])) }))
jest.mock('@/services/access/basePlan.service', () => ({
  venueHasFeatureAccess: jest.fn(async () => true),
  venuesWithFeatureAccess: jest.fn(async (ids: string[]) => ids),
}))
jest.mock('@/services/dashboard/product.dashboard.service', () => ({ createProduct: jest.fn(), updateProduct: jest.fn() }))
jest.mock('@/services/mobile/inventory.mobile.service', () => ({
  createStockCount: (...a: unknown[]) => mockCreateCount(...(a as [])),
  updateStockCount: (...a: unknown[]) => mockUpdateCount(...(a as [])),
  confirmStockCount: (...a: unknown[]) => mockConfirmCount(...(a as [])),
  cancelStockCount: (...a: unknown[]) => mockCancelCount(...(a as [])),
}))

type Handler = (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>
const handlers = new Map<string, Handler>()
const schemas = new Map<string, Record<string, z.ZodTypeAny>>()
const scope = { staffId: 'staff-1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('set_stock_by_code')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)
const D = (n: number) => new Prisma.Decimal(n)
/** Una línea como la deja guardada el conteo: aplicada, retenida por Shopify o sin aplicar. */
const linea = (productId: string, estado: 'aplicada' | 'retenida' | 'pendiente' = 'aplicada', motivo = 'ENVIO_EN_CAMINO') => ({
  productId,
  appliedAt: estado === 'pendiente' ? null : new Date(),
  shopifyHeldAt: estado === 'retenida' ? new Date() : null,
  shopifyHeldReason: estado === 'retenida' ? motivo : null,
})
/** Un movimiento COUNT del conteo (`filaProducto` nombra el inventario `inv-<id>`). */
const movimiento = (inventoryId: string, antes: number, despues: number) => ({ inventoryId, previousStock: D(antes), newStock: D(despues) })

/** Cuándo creó el conteo el servicio (`createStockCount` lo devuelve como texto ISO): la relectura de movimientos parte de 1 min antes. */
const CONTEO_CREADO = '2026-10-14T18:00:00.000Z'

const p1 = filaProducto({ id: 'p1', name: 'Vestido Mailen M', sku: 'MAILEN-M', gtin: '8445000000017', stock: 0 })
const p2 = filaProducto({ id: 'p2', name: 'Vestido Dueñas M', sku: 'DUENAS-M', stock: 2 })
/** Vista previa y confirmación con la huella que devolvió la vista previa (llamando al handler directo). */
async function confirmar(args: Record<string, unknown>) {
  const vista = parse(await call(args))
  return parse(await call({ ...args, confirm: true, expectedSourceFingerprint: vista.expectedSourceFingerprint }))
}
/** `message` va antes de las listas: un cliente que recorte una respuesta de 500 renglones no pierde el aviso de seguridad. */
function mensajeVaAntesDeLasListas(out: Record<string, unknown>) {
  const claves = Object.keys(out)
  expect(claves).toEqual(expect.arrayContaining(['message', 'changes']))
  expect(claves.indexOf('message')).toBeLessThan(claves.indexOf('changes'))
}

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
  // Un valor encolado que una prueba no gastó no debe pasar a la siguiente.
  for (const m of [
    mockProductFindMany,
    mockLinkFindMany,
    mockLineFindMany,
    mockMovementFindMany,
    mockCreateCount,
    mockUpdateCount,
    mockConfirmCount,
    mockCancelCount,
    mockPlanGate,
  ])
    m.mockReset()
  mockPlanGate.mockResolvedValue(null)
  mockLinkFindMany.mockResolvedValue([])
  mockLineFindMany.mockResolvedValue([])
  mockMovementFindMany.mockResolvedValue([])
  mockCreateCount.mockImplementation(async (_v: string, _s: string, _t: string, ids: string[]) => ({
    id: 'sc1',
    revision: 0,
    createdAt: CONTEO_CREADO,
    items: ids.map((productId, i) => ({ id: `l${i + 1}`, productId })),
  }))
  mockUpdateCount.mockResolvedValue({ success: true, revision: 1 })
  mockConfirmCount.mockResolvedValue({ success: true, revision: 2 })
  mockCancelCount.mockResolvedValue({ success: true })
})

describe('set_stock_by_code', () => {
  it('sin el plan de inventario: planRequired y no lee ni escribe nada', async () => {
    mockPlanGate.mockResolvedValueOnce(
      'El control de inventario no está incluido en el plan actual de este local (requiere INVENTORY_TRACKING).',
    )
    const out = parse(await call({ venueId: 'v1', items: [{ code: 'MAILEN-M', quantity: 5 }] }))
    expect(out).toMatchObject({ ok: false, planRequired: true })
    expect(mockProductFindMany).not.toHaveBeenCalled()
    expect(mockCreateCount).not.toHaveBeenCalled()
  })

  it('pide los tres permisos que pide el conteo del POS (confirmar, crear y llenar)', async () => {
    mockProductFindMany.mockResolvedValueOnce([])
    await call({ venueId: 'v1', items: [{ code: 'X', quantity: 1 }] })
    expect(mockRequirePermission.mock.calls).toEqual([
      ['inventory:adjust', 'v1'],
      ['inventory:create', 'v1'],
      ['inventory:update', 'v1'],
    ])
  })

  it('vista previa: actual → final con su diferencia; sin seguimiento, desactivados y ligados a Shopify; NO cuenta nada', async () => {
    mockProductFindMany.mockResolvedValueOnce([
      p1,
      p2,
      filaProducto({ id: 'p3', sku: 'RECETA-1', inventoryMethod: 'RECIPE' }),
      filaProducto({ id: 'p4', sku: 'APAGADO-1', active: false, stock: 1 }),
    ])
    mockLinkFindMany.mockResolvedValueOnce([{ productId: 'p2' }])
    const out = parse(
      await call({
        venueId: 'v1',
        items: [
          { code: '8445000000017', quantity: 5 },
          { code: 'DUEÑAS-M', quantity: 2 },
          { code: 'RECETA-1', quantity: 3 },
          { code: 'APAGADO-1', quantity: 4 },
        ],
      }),
    )
    expect(out.requiresConfirmation).toBe(true)
    expect(out.changes).toEqual([{ code: '8445000000017', sku: 'MAILEN-M', name: 'Vestido Mailen M', from: 0, to: 5, delta: 5 }])
    expect(out.unchanged).toBe(1)
    expect(out.notTracked).toEqual([expect.objectContaining({ code: 'RECETA-1', reason: expect.stringContaining('receta') })])
    expect(out.inactive).toEqual([{ code: 'APAGADO-1', sku: 'APAGADO-1', name: 'Prenda p4' }])
    expect(out.shopifyLinked).toBe(1)
    expect(out.message).toContain('apartadas')
    expect(out.message).toContain('mientras se conecta la tienda') // Shopify también retiene mientras la tienda se conecta
    mensajeVaAntesDeLasListas(out)
    expect(mockLinkFindMany.mock.calls[0][0]).toMatchObject({
      where: { venueId: { in: ['v1'] }, productId: { in: ['p1', 'p2'] } },
      take: 2,
    })
    expect(mockCreateCount).not.toHaveBeenCalled()
  })

  it('si nada cambia y nada está ligado a Shopify, contesta ok sin pedir confirmación', async () => {
    mockProductFindMany.mockResolvedValueOnce([p2])
    const out = parse(await call({ venueId: 'v1', items: [{ code: 'DUENAS-M', quantity: 2 }] }))
    expect(out).toMatchObject({ ok: true, applied: 0, unchanged: 1 })
    expect(out.requiresConfirmation).toBeUndefined()
  })

  it('con confirm: crea un conteo, lo llena con lo contado y la nota, lo confirma y reporta lo que GUARDÓ; UNA bitácora', async () => {
    mockProductFindMany.mockResolvedValue([p1, p2])
    mockLineFindMany.mockResolvedValueOnce([linea('p1'), linea('p2')])
    mockMovementFindMany.mockResolvedValueOnce([movimiento('inv-p1', 0, 5)])
    const out = await confirmar({
      venueId: 'v1',
      items: [
        { code: '8445000000017', quantity: 5 },
        { code: 'DUENAS-M', quantity: 2 },
      ],
    })
    expect(mockCreateCount).toHaveBeenCalledWith('v1', 'staff-1', 'CYCLE', ['p1', 'p2'])
    expect(mockUpdateCount).toHaveBeenCalledWith(
      'sc1',
      'v1',
      [
        { id: 'l1', counted: 5 },
        { id: 'l2', counted: 2 },
      ],
      'Conteo cargado desde la IA',
      0,
    )
    expect(mockConfirmCount).toHaveBeenCalledTimes(1)
    expect(mockConfirmCount).toHaveBeenCalledWith('sc1', 'v1', 'staff-1', 1)
    expect(out).toMatchObject({ ok: true, countId: 'sc1', applied: 2, unchanged: 1, held: [], notApplied: [] })
    expect(out.changes).toEqual([{ code: '8445000000017', sku: 'MAILEN-M', name: 'Vestido Mailen M', productId: 'p1', from: 0, to: 5 }])
    expect(mockLineFindMany.mock.calls[0][0]).toMatchObject({
      where: { stockCountId: 'sc1', stockCount: { venueId: { in: ['v1'] } } },
      take: 2,
    })
    expect(mockMovementFindMany.mock.calls[0][0]).toMatchObject({
      where: {
        inventoryId: { in: ['inv-p1', 'inv-p2'] },
        inventory: { venueId: { in: ['v1'] } },
        type: 'COUNT',
        reason: { startsWith: 'Conteo de inventario #sc1' },
        // Sólo desde que se creó el conteo (con 1 min de holgura): sin este límite se recorre todo el historial de conteos.
        createdAt: { gte: new Date('2026-10-14T17:59:00.000Z') },
      },
      take: 2,
    })
    expect(mockLogAction).toHaveBeenCalledTimes(1)
    expect(mockLogAction.mock.calls[0][0]).toMatchObject({
      action: 'STOCK_LEVELS_SET_BULK',
      entity: 'Venue',
      entityId: 'v1',
      data: {
        countId: 'sc1',
        source: 'customer-mcp',
        reason: 'Conteo cargado desde la IA',
        changes: [{ productId: 'p1', sku: 'MAILEN-M', from: 0, to: 5 }],
      },
    })
  })

  it('Shopify: lo retenido sale en held con qué hacer; los ligados salen marcados, con su antes → después real y el aviso de apartadas', async () => {
    mockProductFindMany.mockResolvedValue([p1, p2])
    mockLinkFindMany.mockResolvedValue([{ productId: 'p1' }, { productId: 'p2' }])
    mockLineFindMany.mockResolvedValueOnce([linea('p1'), linea('p2', 'retenida')])
    mockMovementFindMany.mockResolvedValueOnce([movimiento('inv-p1', 0, 3)])
    const out = await confirmar({
      venueId: 'v1',
      reason: 'Saldo inicial',
      items: [
        { code: 'MAILEN-M', quantity: 5 },
        { code: 'DUENAS-M', quantity: 4 },
      ],
    })
    expect(mockUpdateCount.mock.calls[0][3]).toBe('Saldo inicial')
    expect(out.applied).toBe(1)
    expect(out.held).toEqual([
      { code: 'DUENAS-M', sku: 'DUENAS-M', name: 'Vestido Dueñas M', reason: expect.stringContaining('Vuelve a cargarlo') },
    ])
    // Lo apartado NO se calcula (no se guarda en ningún lado): se dice lo que de verdad pasó y por qué puede quedar menos.
    expect(out.changes).toEqual([
      { code: 'MAILEN-M', sku: 'MAILEN-M', name: 'Vestido Mailen M', productId: 'p1', from: 0, to: 3, shopify: true },
    ])
    expect(out.message).toContain('apartadas')
  })

  it('🔍 un ligado a Shopify que quedó igual (lo contado menos lo apartado ya era lo que había) no se presenta como cuadrado: sale el aviso', async () => {
    mockProductFindMany.mockResolvedValue([filaProducto({ id: 'p1', name: 'Vestido Mailen M', sku: 'MAILEN-M', stock: 7 })])
    mockLinkFindMany.mockResolvedValue([{ productId: 'p1' }])
    mockLineFindMany.mockResolvedValueOnce([linea('p1')]) // sellada y sin movimiento: 9 contadas − 2 apartadas = las 7 que había
    const out = await confirmar({ venueId: 'v1', items: [{ code: 'MAILEN-M', quantity: 9 }] })
    expect(out).toMatchObject({ ok: true, applied: 1, unchanged: 1, changes: [] })
    expect(out.message).toContain('apartadas')
  })

  it('🔍 lo que se reporta sale de lo que el conteo GUARDÓ: aunque la confirmación no traiga las retenidas, se dicen', async () => {
    mockProductFindMany.mockResolvedValue([p1])
    mockConfirmCount.mockResolvedValueOnce({ success: true, revision: 2 }) // p. ej. otro aparato ya lo había terminado
    mockLineFindMany.mockResolvedValueOnce([linea('p1', 'retenida', 'DUDA_POR_REVISAR')])
    const out = await confirmar({ venueId: 'v1', items: [{ code: 'MAILEN-M', quantity: 5 }] })
    expect(out).toMatchObject({ ok: false, applied: 0 })
    expect(out.held).toEqual([expect.objectContaining({ code: 'MAILEN-M', reason: expect.stringContaining('por revisar') })])
  })

  it('🔍 si Shopify retiene TODAS las líneas (ENVIO_EN_CAMINO): no dice «Listo», dice que no se aplicó nada y qué hacer, y el mensaje va antes de las listas', async () => {
    mockProductFindMany.mockResolvedValue([p1])
    mockLinkFindMany.mockResolvedValue([{ productId: 'p1' }])
    mockLineFindMany.mockResolvedValueOnce([linea('p1', 'retenida', 'ENVIO_EN_CAMINO')])
    const out = await confirmar({ venueId: 'v1', items: [{ code: 'MAILEN-M', quantity: 5 }] })
    expect(out).toMatchObject({ ok: false, applied: 0 })
    expect(out.message).toMatch(/^No se aplicó ningún producto del conteo\./)
    expect(out.message).not.toContain('Listo')
    expect(out.held).toHaveLength(1)
    expect(out.held[0].reason).toContain('después de aplicar la conexión')
    // La retención dura hasta que el dueño aplica la conexión (tienda en CONNECTING o REVIEWING): no es cosa de minutos.
    expect(out.held[0].reason).not.toContain('unos minutos')
    mensajeVaAntesDeLasListas(out)
  })

  it('una línea que el conteo no aplicó (el producto dejó de llevar existencias) sale en notApplied', async () => {
    mockProductFindMany.mockResolvedValue([p1, p2])
    mockLineFindMany.mockResolvedValueOnce([linea('p1'), linea('p2', 'pendiente')])
    mockMovementFindMany.mockResolvedValueOnce([movimiento('inv-p1', 0, 5)])
    const out = await confirmar({
      venueId: 'v1',
      items: [
        { code: 'MAILEN-M', quantity: 5 },
        { code: 'DUENAS-M', quantity: 7 },
      ],
    })
    expect(out.applied).toBe(1)
    expect(out.notApplied).toEqual([
      { code: 'DUENAS-M', sku: 'DUENAS-M', name: 'Vestido Dueñas M', reason: expect.stringContaining('no lleva existencias') },
    ])
  })

  it('si una existencia cambió desde la vista previa (una venta), no cuenta NADA y pide otra vista previa', async () => {
    mockProductFindMany
      .mockResolvedValueOnce([filaProducto({ id: 'p1', sku: 'MAILEN-M', stock: 4 })])
      .mockResolvedValueOnce([filaProducto({ id: 'p1', sku: 'MAILEN-M', stock: 3 })])
    const out = await confirmar({ venueId: 'v1', items: [{ code: 'MAILEN-M', quantity: 5 }] })
    expect(out).toMatchObject({ ok: false, stale: true, needsInput: true })
    expect(mockCreateCount).not.toHaveBeenCalled()
  })

  it('🔍 si dos códigos cambiaron de producto desde la vista previa (mismas existencias), no cuenta nada', async () => {
    const a = filaProducto({ id: 'pa', sku: 'A-M', gtin: '7500000000001', stock: 1 })
    const b = filaProducto({ id: 'pb', sku: 'B-M', gtin: '7500000000002', stock: 2 })
    const aCambiado = filaProducto({ id: 'pa', sku: 'A-M', gtin: '7500000000002', stock: 1 })
    const bCambiado = filaProducto({ id: 'pb', sku: 'B-M', gtin: '7500000000001', stock: 2 })
    mockProductFindMany.mockResolvedValueOnce([a, b]).mockResolvedValueOnce([aCambiado, bCambiado])
    const out = await confirmar({
      venueId: 'v1',
      items: [
        { code: '7500000000001', quantity: 5 },
        { code: '7500000000002', quantity: 6 },
      ],
    })
    expect(out).toMatchObject({ ok: false, stale: true })
    expect(mockCreateCount).not.toHaveBeenCalled()
  })

  it('un producto que el conteo ya no aceptó (se desactivó en medio) sale en notApplied; el resto se cuenta', async () => {
    mockProductFindMany.mockResolvedValue([p1, p2])
    mockCreateCount.mockResolvedValueOnce({ id: 'sc1', revision: 0, createdAt: CONTEO_CREADO, items: [{ id: 'l1', productId: 'p1' }] })
    mockLineFindMany.mockResolvedValueOnce([linea('p1')])
    mockMovementFindMany.mockResolvedValueOnce([movimiento('inv-p1', 0, 5)])
    const out = await confirmar({
      venueId: 'v1',
      items: [
        { code: 'MAILEN-M', quantity: 5 },
        { code: 'DUENAS-M', quantity: 7 },
      ],
    })
    expect(mockUpdateCount).toHaveBeenCalledWith('sc1', 'v1', [{ id: 'l1', counted: 5 }], 'Conteo cargado desde la IA', 0)
    expect(out.notApplied).toEqual([
      expect.objectContaining({ code: 'DUENAS-M', reason: expect.stringContaining('Cambió desde la vista previa') }),
    ])
    expect(out.applied).toBe(1)
  })

  it('si llenar el conteo falla, cancela el borrador con SU revisión (nada se aplicó) y lo dice', async () => {
    mockProductFindMany.mockResolvedValue([p1])
    mockUpdateCount.mockRejectedValueOnce(Object.assign(new Error('El conteo cambió desde que lo viste.'), { isOperational: true }))
    const out = await confirmar({ venueId: 'v1', items: [{ code: 'MAILEN-M', quantity: 5 }] })
    expect(mockCancelCount).toHaveBeenCalledWith('sc1', 'v1', 'staff-1', 0)
    expect(mockConfirmCount).not.toHaveBeenCalled()
    expect(out).toEqual({ ok: false, error: 'El conteo cambió desde que lo viste.' })
  })

  it('🔍 si llenar falla y tampoco se puede cancelar, da el conteo y manda a revisarlo, sin afirmar en qué estado quedó', async () => {
    mockProductFindMany.mockResolvedValue([p1])
    mockUpdateCount.mockRejectedValueOnce(Object.assign(new Error('El conteo cambió desde que lo viste.'), { isOperational: true }))
    mockCancelCount.mockRejectedValueOnce(Object.assign(new Error('El conteo cambió desde que lo viste.'), { isOperational: true }))
    const out = await confirmar({ venueId: 'v1', items: [{ code: 'MAILEN-M', quantity: 5 }] })
    expect(out).toMatchObject({ ok: false, countId: 'sc1' })
    expect(out.message).toContain('Revisa el conteo en el POS')
    expect(out.message).not.toMatch(/abierto|sin aplicar nada/) // otro operador pudo haberlo terminado: no se afirma lo que no se comprobó
    // La causa de que no se pudiera cancelar no se pierde: queda en el log, con el conteo.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('set_stock_by_code: no se pudo cancelar el conteo'),
      expect.objectContaining({ countId: 'sc1', error: 'El conteo cambió desde que lo viste.' }),
    )
  })

  it('🔍 si la confirmación truena una vez, la reintenta sobre el MISMO conteo y termina', async () => {
    mockProductFindMany.mockResolvedValue([p1])
    mockConfirmCount.mockRejectedValueOnce(new Error('connection reset')).mockResolvedValueOnce({ success: true, revision: 2 })
    mockLineFindMany.mockResolvedValueOnce([linea('p1')])
    mockMovementFindMany.mockResolvedValueOnce([movimiento('inv-p1', 0, 5)])
    const out = await confirmar({ venueId: 'v1', items: [{ code: 'MAILEN-M', quantity: 5 }] })
    expect(mockCreateCount).toHaveBeenCalledTimes(1)
    expect(mockConfirmCount.mock.calls).toEqual([
      ['sc1', 'v1', 'staff-1', 1],
      ['sc1', 'v1', 'staff-1', 1],
    ])
    expect(out).toMatchObject({ ok: true, countId: 'sc1', applied: 1 })
    // El primer intento que falló deja su causa en el log aunque el reintento termine; el reintento que sale bien no se registra.
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('set_stock_by_code: falló la confirmación del conteo'),
      expect.objectContaining({ countId: 'sc1', intento: 1, error: 'connection reset' }),
    )
  })

  it('🔍 si la confirmación truena dos veces: NO cancela, dice qué quedó y manda a terminarlo en el POS, no a recargar la lista', async () => {
    mockProductFindMany.mockResolvedValue([p1, p2])
    mockConfirmCount.mockRejectedValue(Object.assign(new Error('Otro dispositivo está aplicando este conteo.'), { isOperational: true }))
    mockLineFindMany.mockResolvedValueOnce([linea('p1'), linea('p2', 'pendiente')])
    mockMovementFindMany.mockResolvedValueOnce([movimiento('inv-p1', 0, 5)])
    const out = await confirmar({
      venueId: 'v1',
      items: [
        { code: 'MAILEN-M', quantity: 5 },
        { code: 'DUENAS-M', quantity: 7 },
      ],
    })
    expect(mockConfirmCount).toHaveBeenCalledTimes(2)
    expect(mockCancelCount).not.toHaveBeenCalled()
    expect(out).toMatchObject({ ok: false, countId: 'sc1', applied: 1 })
    expect(out.notApplied).toEqual([expect.objectContaining({ code: 'DUENAS-M', reason: 'No se alcanzó a aplicar.' })])
    expect(out.message).toContain('termínalo en el POS')
    // Cancelar un conteo abierto NO deshace lo ya sellado: se dice que no lo cancele, además de que no recargue la lista.
    expect(out.message).toContain('No lo canceles (no deshace lo ya aplicado)')
    expect(out.message).toContain('ni vuelvas a cargar la lista completa')
    expect(out.message).not.toContain('a medias') // otro operador pudo haberlo terminado: se dice lo guardado, no un estado supuesto
    mensajeVaAntesDeLasListas(out)
    expect(mockLogAction).toHaveBeenCalledTimes(1)
    expect(mockLogAction.mock.calls[0][0]).toMatchObject({ action: 'STOCK_LEVELS_SET_BULK', data: { countId: 'sc1', partial: true } })
    // Cada intento fallido deja su causa en el log.
    for (const intento of [1, 2])
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('set_stock_by_code: falló la confirmación del conteo'),
        expect.objectContaining({ countId: 'sc1', intento, error: 'Otro dispositivo está aplicando este conteo.' }),
      )
  })

  it('🔍 si la confirmación truena dos veces, el «sin aplicar» cuenta las retenidas y el aviso de apartadas no se pierde', async () => {
    mockProductFindMany.mockResolvedValue([p1, p2])
    mockLinkFindMany.mockResolvedValue([{ productId: 'p1' }, { productId: 'p2' }])
    mockConfirmCount.mockRejectedValue(new Error('connection reset'))
    mockLineFindMany.mockResolvedValueOnce([linea('p1'), linea('p2', 'retenida')]) // p1 sellada sin movimiento; p2 retenida
    const out = await confirmar({
      venueId: 'v1',
      items: [
        { code: 'MAILEN-M', quantity: 5 },
        { code: 'DUENAS-M', quantity: 4 },
      ],
    })
    expect(out).toMatchObject({ ok: false, countId: 'sc1', applied: 1, changes: [], notApplied: [] })
    expect(out.held).toHaveLength(1)
    expect(out.message).toContain('1 producto(s) aplicados y 1 sin aplicar')
    expect(out.message).toContain('apartadas')
    expect(out.message).toContain('No lo canceles (no deshace lo ya aplicado)')
    expect(out.message).toContain('ni vuelvas a cargar la lista completa')
  })

  it('🔍 si la confirmación truena dos veces y tampoco se puede leer lo guardado: conserva el conteo, no da cifras y no manda a recargar', async () => {
    mockProductFindMany.mockResolvedValue([p1])
    mockConfirmCount.mockRejectedValue(new Error('connection reset'))
    mockLineFindMany.mockRejectedValueOnce(new Error('connection reset'))
    const out = await confirmar({ venueId: 'v1', items: [{ code: 'MAILEN-M', quantity: 5 }] })
    expect(out).toMatchObject({ ok: false, countId: 'sc1', outcomeUnknown: true })
    expect(out).not.toHaveProperty('applied')
    expect(out.message).toContain('No lo canceles (no deshace lo ya aplicado)')
    expect(out.message).toContain('ni vuelvas a cargar la lista completa')
    expect(mockLogAction.mock.calls[0][0]).toMatchObject({
      action: 'STOCK_LEVELS_SET_BULK',
      data: { countId: 'sc1', outcomeUnknown: true, partial: true },
    })
  })

  it('🔍 si el conteo se confirmó pero no se pueden leer sus movimientos: dice que se guardó y que el detalle se ve en el POS', async () => {
    mockProductFindMany.mockResolvedValue([p1])
    mockLineFindMany.mockResolvedValueOnce([linea('p1')])
    mockMovementFindMany.mockRejectedValueOnce(new Error('connection reset'))
    const out = await confirmar({ venueId: 'v1', items: [{ code: 'MAILEN-M', quantity: 5 }] })
    expect(out).toMatchObject({ ok: true, countId: 'sc1', outcomeUnknown: true })
    expect(out.message).toContain('POS')
  })

  it('🔍 el mismo producto por dos códigos no se carga, y se dice', async () => {
    mockProductFindMany.mockResolvedValueOnce([p1])
    const out = parse(
      await call({
        venueId: 'v1',
        items: [
          { code: 'MAILEN-M', quantity: 5 },
          { code: 'MAILEN-M', quantity: 6 },
          { code: '8445000000017', quantity: 7 },
        ],
      }),
    )
    expect(out).toMatchObject({ ok: true, applied: 0 })
    expect(out.duplicateCodes).toEqual(['MAILEN-M'])
    expect(out.sameProductTwice).toEqual([{ codes: ['MAILEN-M', '8445000000017'], sku: 'MAILEN-M', name: 'Vestido Mailen M' }])
  })

  it('topes: 500 renglones sí, 501 no; cantidad negativa o con 4 decimales no', () => {
    const s = z.object(schemas.get('set_stock_by_code')!)
    const renglones = (n: number, quantity = 1) => Array.from({ length: n }, (_, i) => ({ code: `C${i}`, quantity }))
    expect(s.safeParse({ venueId: 'v1', items: renglones(500) }).success).toBe(true)
    expect(s.safeParse({ venueId: 'v1', items: renglones(501) }).success).toBe(false)
    expect(s.safeParse({ venueId: 'v1', items: renglones(1, -1) }).success).toBe(false)
    expect(s.safeParse({ venueId: 'v1', items: renglones(1, 1.2345) }).success).toBe(false)
  })
})

describe('set_stock_by_code por el catálogo real', () => {
  it('el token ata la huella y la confirmación con lo firmado guarda el conteo', async () => {
    mockProductFindMany.mockResolvedValue([p1])
    mockLineFindMany.mockResolvedValue([linea('p1')])
    mockMovementFindMany.mockResolvedValue([movimiento('inv-p1', 0, 5)])
    const c = await conectarPorElCatalogo(server => registerCatalogInBulkTools(server, scope), scope)
    try {
      const { vista, resultado } = await confirmarPorElCatalogo(c, 'set_stock_by_code', {
        venueId: 'v1',
        items: [{ code: 'MAILEN-M', quantity: 5 }],
      })
      expect(vista.confirmationArguments.expectedSourceFingerprint).toBe(vista.expectedSourceFingerprint)
      expect(resultado).toMatchObject({ ok: true, countId: 'sc1', applied: 1 })
    } finally {
      await c.close()
    }
  })
})
