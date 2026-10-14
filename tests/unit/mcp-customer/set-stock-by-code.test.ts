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
const mockStockCountFindMany = jest.fn()
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
    stockCount: { findMany: (...a: unknown[]) => mockStockCountFindMany(...(a as [])) },
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
/** Una pareja de Shopify que puede tocar el conteo (no suspendida, sucursal no desconectada), con sus piezas apartadas. */
const pareja = (productId: string, apartadas = 0) => ({
  productId,
  mirrorCommitted: apartadas,
  initializedAt: new Date('2026-10-01T00:00:00.000Z'),
})

// Textos para el operador, tal cual (el asistente los repite).
const EXISTENCIA_VIEJA_ERROR = 'Cambió la existencia de algún producto desde la vista previa: no se aplicó nada.'
const EXISTENCIA_VIEJA =
  'Cambió la existencia de algún producto desde la vista previa (por ejemplo, una venta o un conteo): no se aplicó nada. Si ya habías confirmado esta carga y no viste la respuesta, revisa primero los conteos recientes (stock_counts): probablemente ya quedó. Si no, pide una vista previa nueva y compárala con la anterior: si un producto bajó porque se vendió DESPUÉS de contarlo, réstale esa venta a lo contado antes de confirmar.'
const NOTA_CONTEO_ABIERTO =
  ' Los que están en un conteo abierto no se cargan: termina ese conteo en el POS (Inventario › Conteos), o cancélalo si no aplicó nada.'
/** En las respuestas de una confirmación que no terminó: el «no canceles» es de ESTE conteo, así que del otro no se aconseja cancelar. */
const NOTA_OTRO_CONTEO_ABIERTO =
  ' Los que están en otro conteo abierto (ver inOpenCount) no se cargaron: termina ese otro conteo en el POS.'
const ENVIO_EN_CAMINO =
  'Shopify todavía lo está sincronizando (un envío en camino, o la tienda se está conectando): su existencia en Avoqado no cambió. Vuelve a cargar sólo ese producto cuando Shopify termine; si estás conectando la tienda, después de aplicar la conexión.'
const DUDA_POR_REVISAR =
  'Tiene un cambio con Shopify por revisar: no se aplicó. Resuélvelo en la página de Shopify del dashboard (Ajustes › Integraciones) y vuelve a cargar sólo ese producto.'

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
/** En las respuestas que piden revisar la lista: `message` justo después de `ok` y `needsInput`, antes de cualquier lista. */
const mensajePrimero = (out: Record<string, unknown>) => expect(Object.keys(out).slice(0, 3)).toEqual(['ok', 'needsInput', 'message'])
/** En las respuestas de una confirmación que no terminó: `message` justo tras `countId`, y lo que quedó fuera al final. */
function mensajeTrasElConteoYExcluidosAlFinal(out: Record<string, unknown>, ultimaLista?: string) {
  const claves = Object.keys(out)
  expect(claves.indexOf('message')).toBe(claves.indexOf('countId') + 1)
  expect(claves.slice(-8)).toEqual([
    'notFound',
    'ambiguous',
    'archived',
    'duplicateCodes',
    'sameProductTwice',
    'notTracked',
    'inactive',
    'inOpenCount',
  ])
  if (ultimaLista) expect(claves.indexOf('notFound')).toBeGreaterThan(claves.indexOf(ultimaLista))
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
    mockStockCountFindMany,
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
  mockStockCountFindMany.mockResolvedValue([]) // ningún conteo abierto
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

  it('vista previa: actual → final (sin delta); un ligado a Shopify va en changes aunque lo contado sea lo que hay; NO cuenta nada', async () => {
    mockProductFindMany.mockResolvedValueOnce([
      p1,
      p2,
      filaProducto({ id: 'p3', sku: 'RECETA-1', inventoryMethod: 'RECIPE' }),
      filaProducto({ id: 'p4', sku: 'APAGADO-1', active: false, stock: 1 }),
    ])
    mockLinkFindMany.mockResolvedValueOnce([pareja('p2', 1)])
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
    // p2: contadas 2 = las 2 que hay, pero ligada a Shopify: el conteo le resta lo apartado en línea, así que también cambia (Codex H3).
    expect(out.changes).toEqual([
      { code: '8445000000017', sku: 'MAILEN-M', name: 'Vestido Mailen M', from: 0, to: 5 },
      { code: 'DUEÑAS-M', sku: 'DUENAS-M', name: 'Vestido Dueñas M', from: 2, to: 2, shopify: true },
    ])
    expect(out.unchanged).toBe(0)
    expect(out.notTracked).toEqual([expect.objectContaining({ code: 'RECETA-1', reason: expect.stringContaining('receta') })])
    expect(out.inactive).toEqual([{ code: 'APAGADO-1', sku: 'APAGADO-1', name: 'Prenda p4' }])
    expect(out.inOpenCount).toEqual([])
    expect(out.shopifyLinked).toBe(1)
    expect(out.message).toBe(
      'Esto guardará un conteo de 2 producto(s) (2 cambian o los ajusta Shopify). 1 están ligados a Shopify: se restan de lo contado las piezas apartadas por pedidos en línea, y Shopify puede retener alguno (por ejemplo, mientras se conecta la tienda); la respuesta dirá cuáles. Quedaron fuera: sin existencias por pieza 1, desactivados 1 (ver esas listas). Muéstrale la lista al operador; con su autorización vuelve a llamar con confirm:true.',
    )
    mensajeVaAntesDeLasListas(out)
    // Sólo las parejas que pueden tocar el conteo: suspendidas y sucursales desconectadas no restan nada.
    expect(mockLinkFindMany.mock.calls[0][0]).toEqual({
      where: {
        venueId: { in: ['v1'] },
        productId: { in: ['p1', 'p2'] },
        suspendedReason: null,
        locationLink: { status: { not: 'DISCONNECTED' } },
      },
      select: { productId: true, mirrorCommitted: true, initializedAt: true },
      take: 2,
    })
    expect(mockCreateCount).not.toHaveBeenCalled()
  })

  it('si nada cambia y nada está ligado a Shopify: ok sin pedir confirmación, cuántos ya tenían esa existencia y qué quedó fuera', async () => {
    mockProductFindMany.mockResolvedValueOnce([p2])
    const out = parse(
      await call({
        venueId: 'v1',
        items: [
          { code: 'DUENAS-M', quantity: 2 },
          { code: 'NO-EXISTE', quantity: 1 },
        ],
      }),
    )
    expect(out).toMatchObject({ ok: true, applied: 0, unchanged: 1, notFound: ['NO-EXISTE'] })
    expect(out.requiresConfirmation).toBeUndefined()
    expect(out.message).toBe(
      'Los 1 producto(s) ya tienen esa existencia: no hay nada que cambiar. Quedaron fuera: sin encontrar 1 (ver esas listas).',
    )
  })

  it('🔍 si ningún producto de la lista se puede cargar: ok:false con needsInput (nunca «nada que cambiar») y lo que quedó fuera', async () => {
    mockProductFindMany.mockResolvedValueOnce([filaProducto({ id: 'p3', sku: 'RECETA-1', inventoryMethod: 'RECIPE' })])
    const out = parse(
      await call({
        venueId: 'v1',
        items: [
          { code: 'RECETA-1', quantity: 3 },
          { code: 'NO-EXISTE', quantity: 1 },
        ],
      }),
    )
    expect(out).toMatchObject({
      ok: false,
      needsInput: true,
      notFound: ['NO-EXISTE'],
      notTracked: [expect.objectContaining({ code: 'RECETA-1' })],
    })
    expect(out).not.toHaveProperty('applied')
    expect(out.message).toBe(
      'Ningún producto de la lista se puede cargar. Quedaron fuera: sin encontrar 1, sin existencias por pieza 1 (ver esas listas). Revisa la lista antes de seguir.',
    )
    mensajePrimero(out)
    expect(mockStockCountFindMany).not.toHaveBeenCalled() // nada que contar: ni se pregunta por conteos abiertos
    expect(mockCreateCount).not.toHaveBeenCalled()
  })

  it('🔴 un producto que ya está en un conteo abierto no se cuenta otra vez: sale en inOpenCount con ese conteo (el más viejo) y no entra al nuevo', async () => {
    mockProductFindMany.mockResolvedValue([p1, p2])
    mockStockCountFindMany.mockResolvedValue([
      { id: 'abierto-viejo', items: [{ productId: 'p2' }] },
      { id: 'abierto-nuevo', items: [{ productId: 'p2' }] },
    ])
    mockLineFindMany.mockResolvedValueOnce([linea('p1')])
    mockMovementFindMany.mockResolvedValueOnce([movimiento('inv-p1', 0, 5)])
    const args = {
      venueId: 'v1',
      items: [
        { code: 'MAILEN-M', quantity: 5 },
        { code: 'DUENAS-M', quantity: 7 },
      ],
    }
    const vista = parse(await call(args))
    expect(mockStockCountFindMany.mock.calls[0][0]).toEqual({
      where: {
        venueId: { in: ['v1'] },
        status: { in: ['IN_PROGRESS', 'APPLYING'] },
        items: { some: { productId: { in: ['p1', 'p2'] } } },
      },
      select: { id: true, items: { where: { productId: { in: ['p1', 'p2'] } }, select: { productId: true }, take: 2 } },
      orderBy: { createdAt: 'asc' },
      take: 50,
    })
    expect(vista.inOpenCount).toEqual([{ code: 'DUENAS-M', sku: 'DUENAS-M', name: 'Vestido Dueñas M', countId: 'abierto-viejo' }])
    expect(vista.changes).toEqual([expect.objectContaining({ code: 'MAILEN-M' })])
    expect(vista.message).toBe(
      'Esto guardará un conteo de 1 producto(s) (1 cambian). Quedaron fuera: en un conteo abierto 1 (ver esas listas).' +
        NOTA_CONTEO_ABIERTO +
        ' Muéstrale la lista al operador; con su autorización vuelve a llamar con confirm:true.',
    )
    const out = parse(await call({ ...args, confirm: true, expectedSourceFingerprint: vista.expectedSourceFingerprint }))
    expect(mockCreateCount).toHaveBeenCalledWith('v1', 'staff-1', 'CYCLE', ['p1'])
    expect(out).toMatchObject({ ok: true, applied: 1, inOpenCount: [expect.objectContaining({ countId: 'abierto-viejo' })] })
    expect(out.message).toContain('Quedaron fuera: en un conteo abierto 1 (ver esas listas).' + NOTA_CONTEO_ABIERTO)
  })

  it('🔴 reenviar la confirmación cuando el primer conteo quedó abierto (falló sin aplicar nada) no abre otro encima', async () => {
    mockProductFindMany.mockResolvedValue([p1])
    const args = { venueId: 'v1', items: [{ code: 'MAILEN-M', quantity: 5 }] }
    const vista = parse(await call(args))
    mockStockCountFindMany.mockResolvedValueOnce([{ id: 'sc1', items: [{ productId: 'p1' }] }]) // el de la primera confirmación
    const out = parse(await call({ ...args, confirm: true, expectedSourceFingerprint: vista.expectedSourceFingerprint }))
    expect(out).toMatchObject({
      ok: false,
      needsInput: true,
      inOpenCount: [{ code: 'MAILEN-M', sku: 'MAILEN-M', name: 'Vestido Mailen M', countId: 'sc1' }],
    })
    expect(out.message).toBe(
      'Ningún producto de la lista se puede cargar. Quedaron fuera: en un conteo abierto 1 (ver esas listas).' +
        NOTA_CONTEO_ABIERTO +
        ' Revisa la lista antes de seguir.',
    )
    mensajePrimero(out)
    expect(mockCreateCount).not.toHaveBeenCalled()
  })

  it('🔍 con 50 conteos abiertos con esos productos no carga nada: pide terminar o cancelar los que sobran', async () => {
    mockProductFindMany.mockResolvedValue([p1])
    mockStockCountFindMany.mockResolvedValueOnce(
      Array.from({ length: 50 }, (_, i) => ({ id: `abierto-${i}`, items: [{ productId: 'p1' }] })),
    )
    const out = parse(await call({ venueId: 'v1', items: [{ code: 'MAILEN-M', quantity: 5 }] }))
    expect(out).toEqual({
      ok: false,
      needsInput: true,
      message:
        'Hay demasiados conteos abiertos en este negocio: termina o cancela los que ya no sirvan en el POS (Inventario › Conteos) antes de cargar existencias.',
    })
    expect(Object.keys(out)).toEqual(['ok', 'needsInput', 'message'])
    expect(mockLinkFindMany).not.toHaveBeenCalled()
    expect(mockCreateCount).not.toHaveBeenCalled()
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
    mockLinkFindMany.mockResolvedValue([pareja('p1', 2), pareja('p2')])
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
    expect(out.held).toEqual([{ code: 'DUENAS-M', sku: 'DUENAS-M', name: 'Vestido Dueñas M', reason: ENVIO_EN_CAMINO }])
    // Lo apartado NO se calcula (no se guarda en ningún lado): se dice lo que de verdad pasó y por qué puede quedar menos.
    expect(out.changes).toEqual([
      { code: 'MAILEN-M', sku: 'MAILEN-M', name: 'Vestido Mailen M', productId: 'p1', from: 0, to: 3, shopify: true },
    ])
    expect(out.message).toContain('apartadas')
  })

  it('🔍 un ligado a Shopify que quedó igual (lo contado menos lo apartado ya era lo que había) no se presenta como cuadrado: sale el aviso', async () => {
    mockProductFindMany.mockResolvedValue([filaProducto({ id: 'p1', name: 'Vestido Mailen M', sku: 'MAILEN-M', stock: 7 })])
    mockLinkFindMany.mockResolvedValue([pareja('p1', 2)])
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
    mockLinkFindMany.mockResolvedValue([pareja('p1')])
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

  it('lo retenido por Shopify pide volver a cargar SÓLO ese producto (los dos motivos, tal cual)', async () => {
    mockProductFindMany.mockResolvedValue([p1, p2])
    mockLinkFindMany.mockResolvedValue([pareja('p1'), pareja('p2')])
    mockLineFindMany.mockResolvedValueOnce([linea('p1', 'retenida', 'ENVIO_EN_CAMINO'), linea('p2', 'retenida', 'DUDA_POR_REVISAR')])
    const out = await confirmar({
      venueId: 'v1',
      items: [
        { code: 'MAILEN-M', quantity: 5 },
        { code: 'DUENAS-M', quantity: 4 },
      ],
    })
    expect(out.held).toEqual([
      { code: 'MAILEN-M', sku: 'MAILEN-M', name: 'Vestido Mailen M', reason: ENVIO_EN_CAMINO },
      { code: 'DUENAS-M', sku: 'DUENAS-M', name: 'Vestido Dueñas M', reason: DUDA_POR_REVISAR },
    ])
  })

  it('🔍 «Listo»: lo aplicado y lo que cambió, lo retenido por Shopify, lo no aplicado y lo que quedó fuera de la lista', async () => {
    const p3 = filaProducto({ id: 'p3', name: 'Falda Caye S', sku: 'CAYE-S', stock: 1 })
    mockProductFindMany.mockResolvedValue([p1, p2, p3])
    mockLinkFindMany.mockResolvedValue([pareja('p2')])
    mockLineFindMany.mockResolvedValueOnce([linea('p1'), linea('p2', 'retenida'), linea('p3', 'pendiente')])
    mockMovementFindMany.mockResolvedValueOnce([movimiento('inv-p1', 0, 5)])
    const out = await confirmar({
      venueId: 'v1',
      items: [
        { code: 'MAILEN-M', quantity: 5 },
        { code: 'DUENAS-M', quantity: 4 },
        { code: 'CAYE-S', quantity: 3 },
        { code: 'NO-EXISTE', quantity: 1 },
      ],
    })
    expect(out).toMatchObject({ ok: true, countId: 'sc1', applied: 1, notFound: ['NO-EXISTE'] })
    expect(out.message).toBe(
      'Listo: se guardó el conteo con 1 producto(s) (1 cambiaron). 1 no se aplicaron por Shopify (ver held). 1 no se aplicaron (ver notApplied). Quedaron fuera: sin encontrar 1 (ver esas listas).',
    )
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

  it('si una existencia cambió desde la vista previa (una venta), no cuenta NADA y dice qué revisar antes de pedir otra vista previa', async () => {
    mockProductFindMany
      .mockResolvedValueOnce([filaProducto({ id: 'p1', sku: 'MAILEN-M', stock: 4 })])
      .mockResolvedValueOnce([filaProducto({ id: 'p1', sku: 'MAILEN-M', stock: 3 })])
    const out = await confirmar({ venueId: 'v1', items: [{ code: 'MAILEN-M', quantity: 5 }] })
    // Ningún campo manda a «confirmar» otra vez: el mensaje pide revisar los conteos y restar la venta antes.
    expect(out).toEqual({ ok: false, stale: true, needsInput: true, error: EXISTENCIA_VIEJA_ERROR, message: EXISTENCIA_VIEJA })
    expect(JSON.stringify(out)).not.toContain('confírmala')
    expect(mockCreateCount).not.toHaveBeenCalled()
  })

  it('🔴 si un conteo fijó el producto después de la vista previa (aunque la existencia volvió a ser la misma), no cuenta NADA', async () => {
    // El caso ABA: la confirmación ya se aplicó (5 → 9), las ventas lo regresaron a 5 y llega la misma confirmación otra vez.
    mockProductFindMany
      .mockResolvedValueOnce([filaProducto({ id: 'p1', sku: 'MAILEN-M', stock: 5 })])
      .mockResolvedValueOnce([filaProducto({ id: 'p1', sku: 'MAILEN-M', stock: 5, lastCountedAt: new Date('2026-10-14T18:01:00.000Z') })])
    const out = await confirmar({ venueId: 'v1', items: [{ code: 'MAILEN-M', quantity: 9 }] })
    expect(out).toEqual({ ok: false, stale: true, needsInput: true, error: EXISTENCIA_VIEJA_ERROR, message: EXISTENCIA_VIEJA })
    expect(mockCreateCount).not.toHaveBeenCalled()
  })

  it('🔴 si cambiaron las piezas apartadas en Shopify de un ligado (mismo disponible), no cuenta NADA', async () => {
    // Un despacho de lo apartado no mueve el disponible, pero sí lo que el conteo le restará a lo contado (Codex H2).
    mockProductFindMany.mockResolvedValue([filaProducto({ id: 'p1', sku: 'MAILEN-M', stock: 7 })])
    mockLinkFindMany.mockResolvedValueOnce([pareja('p1', 2)]).mockResolvedValueOnce([pareja('p1', 1)])
    const out = await confirmar({ venueId: 'v1', items: [{ code: 'MAILEN-M', quantity: 9 }] })
    expect(out).toEqual({ ok: false, stale: true, needsInput: true, error: EXISTENCIA_VIEJA_ERROR, message: EXISTENCIA_VIEJA })
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
    // La causa de que no se pudiera cancelar no se pierde: queda en el log, con el negocio y el conteo.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('set_stock_by_code: no se pudo cancelar el conteo'),
      expect.objectContaining({ venueId: 'v1', countId: 'sc1', error: 'El conteo cambió desde que lo viste.' }),
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
      expect.objectContaining({ venueId: 'v1', countId: 'sc1', intento: 1, error: 'connection reset' }),
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
        { code: 'NO-EXISTE', quantity: 1 },
      ],
    })
    expect(mockConfirmCount).toHaveBeenCalledTimes(2)
    expect(mockCancelCount).not.toHaveBeenCalled()
    expect(out).toMatchObject({ ok: false, countId: 'sc1', applied: 1, notFound: ['NO-EXISTE'] })
    expect(out.notApplied).toEqual([expect.objectContaining({ code: 'DUENAS-M', reason: 'No se alcanzó a aplicar.' })])
    // Cancelar un conteo abierto NO deshace lo ya sellado: se dice que no cancele ESTE conteo, además de que no recargue la lista. Lo
    // que quedó fuera de la lista se cuenta ANTES de esa frase de cierre.
    expect(out.message).toBe(
      'No pude terminar de confirmar el conteo desde aquí. Según lo guardado: 1 producto(s) aplicados y 1 sin aplicar. Quedaron fuera: sin encontrar 1 (ver esas listas). Revísalo y termínalo en el POS (Inventario › Conteos). No canceles este conteo (no deshace lo ya aplicado) ni vuelvas a cargar la lista completa (volvería a fijar lo que ya quedó).',
    )
    expect(out.message).not.toContain('a medias') // otro operador pudo haberlo terminado: se dice lo guardado, no un estado supuesto
    mensajeVaAntesDeLasListas(out)
    mensajeTrasElConteoYExcluidosAlFinal(out, 'notApplied')
    expect(mockLogAction).toHaveBeenCalledTimes(1)
    expect(mockLogAction.mock.calls[0][0]).toMatchObject({ action: 'STOCK_LEVELS_SET_BULK', data: { countId: 'sc1', partial: true } })
    // Cada intento fallido deja su causa en el log, con el negocio.
    for (const intento of [1, 2])
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('set_stock_by_code: falló la confirmación del conteo'),
        expect.objectContaining({ venueId: 'v1', countId: 'sc1', intento, error: 'Otro dispositivo está aplicando este conteo.' }),
      )
  })

  it('🔍 si la confirmación truena dos veces, el «sin aplicar» cuenta las retenidas y el aviso de apartadas no se pierde', async () => {
    mockProductFindMany.mockResolvedValue([p1, p2])
    mockLinkFindMany.mockResolvedValue([pareja('p1', 5), pareja('p2')])
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
    expect(out.message).toContain('No canceles este conteo (no deshace lo ya aplicado)')
    expect(out.message).toContain('ni vuelvas a cargar la lista completa')
  })

  it('🔍 si la confirmación truena y había productos en OTRO conteo abierto: pide terminar ese otro, sin aconsejar cancelarlo', async () => {
    mockProductFindMany.mockResolvedValue([p1, p2])
    mockStockCountFindMany.mockResolvedValue([{ id: 'abierto-1', items: [{ productId: 'p2' }] }])
    mockConfirmCount.mockRejectedValue(new Error('connection reset'))
    mockLineFindMany.mockResolvedValueOnce([linea('p1')])
    mockMovementFindMany.mockResolvedValueOnce([movimiento('inv-p1', 0, 5)])
    const out = await confirmar({
      venueId: 'v1',
      items: [
        { code: 'MAILEN-M', quantity: 5 },
        { code: 'DUENAS-M', quantity: 7 },
      ],
    })
    expect(out).toMatchObject({ ok: false, countId: 'sc1', applied: 1, inOpenCount: [expect.objectContaining({ countId: 'abierto-1' })] })
    expect(out.message).toBe(
      'No pude terminar de confirmar el conteo desde aquí. Según lo guardado: 1 producto(s) aplicados y 0 sin aplicar. Quedaron fuera: en un conteo abierto 1 (ver esas listas).' +
        NOTA_OTRO_CONTEO_ABIERTO +
        ' Revísalo y termínalo en el POS (Inventario › Conteos). No canceles este conteo (no deshace lo ya aplicado) ni vuelvas a cargar la lista completa (volvería a fijar lo que ya quedó).',
    )
    expect(out.message).not.toContain('cancélalo')
  })

  it('🔍 si además no se puede leer lo guardado y había productos en OTRO conteo abierto: lo mismo, sin aconsejar cancelarlo', async () => {
    mockProductFindMany.mockResolvedValue([p1, p2])
    mockStockCountFindMany.mockResolvedValue([{ id: 'abierto-1', items: [{ productId: 'p2' }] }])
    mockConfirmCount.mockRejectedValue(new Error('connection reset'))
    mockLineFindMany.mockRejectedValueOnce(new Error('connection reset'))
    const out = await confirmar({
      venueId: 'v1',
      items: [
        { code: 'MAILEN-M', quantity: 5 },
        { code: 'DUENAS-M', quantity: 7 },
      ],
    })
    expect(out).toMatchObject({
      ok: false,
      countId: 'sc1',
      outcomeUnknown: true,
      inOpenCount: [expect.objectContaining({ countId: 'abierto-1' })],
    })
    expect(out.message).toBe(
      'No pude terminar de confirmar el conteo ni leer cómo quedó. Quedaron fuera: en un conteo abierto 1 (ver esas listas).' +
        NOTA_OTRO_CONTEO_ABIERTO +
        ' Revísalo en el POS (Inventario › Conteos). No canceles este conteo (no deshace lo ya aplicado) ni vuelvas a cargar la lista completa (podría volver a fijar lo que ya quedó).',
    )
    expect(out.message).not.toContain('cancélalo')
  })

  it('🔍 si la confirmación truena dos veces y tampoco se puede leer lo guardado: conserva el conteo, no da cifras y no manda a recargar', async () => {
    mockProductFindMany.mockResolvedValue([p1])
    mockConfirmCount.mockRejectedValue(new Error('connection reset'))
    mockLineFindMany.mockRejectedValueOnce(new Error('connection reset'))
    const out = await confirmar({
      venueId: 'v1',
      items: [
        { code: 'MAILEN-M', quantity: 5 },
        { code: 'NO-EXISTE', quantity: 1 },
      ],
    })
    expect(out).toMatchObject({ ok: false, countId: 'sc1', outcomeUnknown: true, notFound: ['NO-EXISTE'] })
    expect(out).not.toHaveProperty('applied')
    expect(out.message).toBe(
      'No pude terminar de confirmar el conteo ni leer cómo quedó. Quedaron fuera: sin encontrar 1 (ver esas listas). Revísalo en el POS (Inventario › Conteos). No canceles este conteo (no deshace lo ya aplicado) ni vuelvas a cargar la lista completa (podría volver a fijar lo que ya quedó).',
    )
    mensajeTrasElConteoYExcluidosAlFinal(out)
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
    // Nada que contar: no es «nada que cambiar» sino una lista que hay que revisar.
    expect(out).toMatchObject({ ok: false, needsInput: true })
    expect(out.duplicateCodes).toEqual(['MAILEN-M'])
    expect(out.sameProductTwice).toEqual([{ codes: ['MAILEN-M', '8445000000017'], sku: 'MAILEN-M', name: 'Vestido Mailen M' }])
    expect(out.message).toContain('Quedaron fuera: repetidos en la lista 1, mismo producto dos veces 1 (ver esas listas).')
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
