jest.mock('@/services/access/basePlan.service', () => ({
  venueHasFeatureAccess: jest.fn(async () => false),
  venueIsExemptFromPlanGating: jest.fn(async () => false),
}))

import { prismaMock } from '../../../__helpers__/setup'
import { venueHasFeatureAccess, venueIsExemptFromPlanGating } from '@/services/access/basePlan.service'
import { historialInventario, HISTORIAL_INVENTARIO_COLUMNAS } from '@/services/exports/exportadores/historialInventario.exportador'
import { KINDS_EXPORTE, obtenerExportador } from '@/services/exports/exportadores/registry'
import { construirWhereKeyset } from '@/services/exports/exportadores/comun'

/**
 * El Historial de inventario se descarga por el carril de exportes en segundo plano: páginas de a lo más
 * 500 renglones, con corte, y lo grande se arma aparte sin atorar el servidor. Estas pruebas fijan que el
 * archivo sale con los MISMOS filtros que la pantalla, que la mezcla de productos e insumos por páginas no
 * repite ni pierde renglones, y que lo cuida el mismo candado de plan de la pantalla.
 */

const dec = (n: number) => ({ toNumber: () => n })

const movProducto = (id: string, iso: string, over: Partial<any> = {}) => ({
  id,
  createdAt: new Date(iso),
  type: 'SALE',
  quantity: dec(-1),
  previousStock: dec(10),
  newStock: dec(9),
  reason: null,
  reference: 'ORD-1',
  createdBy: 'staff-1',
  wasteReportId: null,
  wasteReport: null,
  unitCost: null,
  inventory: { product: { name: 'Cerveza', sku: 'BEB-1', unit: 'UNIT', cost: dec(20) } },
  ...over,
})

const movInsumo = (id: string, iso: string, over: Partial<any> = {}) => ({
  id,
  createdAt: new Date(iso),
  type: 'PURCHASE',
  quantity: dec(5),
  unit: 'KILOGRAM',
  previousStock: dec(1),
  newStock: dec(6),
  costImpact: dec(50),
  reason: null,
  reference: null,
  createdBy: null,
  wasteReportId: null,
  wasteReport: null,
  rawMaterial: { name: 'Harina', sku: 'ING-1', costPerUnit: dec(10) },
  batch: { purchaseOrderItem: { purchaseOrder: { supplier: { name: 'Molinos' } } } },
  ...over,
})

const fila = (over: Partial<any> = {}) => ({
  id: 'cmov1',
  createdAt: new Date('2026-11-01T18:00:00Z'),
  itemName: 'Cerveza',
  sku: 'BEB-1',
  category: 'PRODUCT',
  type: 'SALE',
  quantity: -2,
  unit: 'UNIT',
  cost: 20,
  totalCost: -40,
  supplierName: null,
  reason: 'Venta',
  reference: 'ORD-1',
  previousStock: 10,
  newStock: 8,
  createdBy: 'staff-1',
  staffName: 'Ana Ruiz',
  wasteReportId: null,
  wasteReasonCode: null,
  wasteUnrecorded: null,
  ...over,
})
const v = (id: string, f: object = fila()) => HISTORIAL_INVENTARIO_COLUMNAS.find(c => c.id === id)!.value(f as never)

describe('exportador historial-inventario', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.inventoryMovement.findMany.mockResolvedValue([] as any)
    prismaMock.rawMaterialMovement.findMany.mockResolvedValue([] as any)
    prismaMock.inventoryMovement.count.mockResolvedValue(0)
    prismaMock.rawMaterialMovement.count.mockResolvedValue(0)
    prismaMock.staff.findMany.mockResolvedValue([] as any)
  })

  it('está registrado con el permiso de la pantalla', () => {
    expect(obtenerExportador('historial-inventario')).toBe(historialInventario)
    expect(KINDS_EXPORTE).toContain('historial-inventario')
    expect(historialInventario).toMatchObject({
      kind: 'historial-inventario',
      titulo: 'Historial de inventario',
      nombreArchivo: 'historial-inventario',
      permiso: 'inventory:read',
    })
  })

  it('valores en las palabras de la pantalla, con signo y sin inventar costo', () => {
    expect(v('type')).toBe('Venta')
    expect(v('type', fila({ type: 'TRANSFER_OUT' }))).toBe('Transferencia (salida)')
    expect(v('type', fila({ type: 'ALGO_NUEVO' }))).toBe('ALGO_NUEVO')
    expect(v('category')).toBe('Producto')
    expect(v('category', fila({ category: 'INGREDIENT' }))).toBe('Insumo')
    expect(v('quantity')).toBe(-2)
    expect(v('totalCost')).toBe(-40)
    expect(v('totalCost', fila({ totalCost: null }))).toBe('Sin valorar')
    expect(v('staffName')).toBe('Ana Ruiz')
    expect(v('supplierName')).toBe('')
    expect(v('createdAt')).toBe('2026-11-01T18:00:00.000Z')
  })

  it('parsearFiltros: búsqueda, fechas y UN tipo; acepta su propia salida', () => {
    const f = historialInventario.parsearFiltros({
      search: '  cerveza ',
      startDate: '2026-11-01T06:00:00.000Z',
      endDate: '2026-11-12T05:59:59.999Z',
      type: 'WASTE',
    })
    expect(f).toEqual({ search: 'cerveza', startDate: '2026-11-01T06:00:00.000Z', endDate: '2026-11-12T05:59:59.999Z', type: 'WASTE' })
    expect(historialInventario.parsearFiltros(f)).toEqual(f)
    expect(historialInventario.parsearFiltros({ type: 'ALL' }).type).toBeUndefined()
    expect(historialInventario.parsearFiltros({ type: 'DROP TABLE' }).type).toBeUndefined()
    // Las opciones del filtro «Tipo» de la pantalla son los tipos reales de cada movimiento.
    expect(historialInventario.parsearFiltros({ type: 'USAGE' }).type).toBe('USAGE')
    expect(historialInventario.parsearFiltros({ type: 'PURCHASE' }).type).toBe('PURCHASE')
    expect(() => historialInventario.parsearFiltros({ startDate: 'no' })).toThrow(/startDate must be a valid ISO date/)
  })

  it('autorizar: el mismo candado de la pantalla (INVENTORY_TRACKING), con superadmin y exentos', async () => {
    const ctx = { venueId: 'v1', staffId: 's1', esSuperadmin: false }
    const bloqueo = await historialInventario.autorizar(ctx, {})
    expect(bloqueo).toMatchObject({ status: 403, body: { featureCode: 'INVENTORY_TRACKING', subscriptionRequired: true } })

    expect(await historialInventario.autorizar({ ...ctx, esSuperadmin: true }, {})).toBeNull()
    ;(venueIsExemptFromPlanGating as jest.Mock).mockResolvedValueOnce(true)
    expect(await historialInventario.autorizar(ctx, {})).toBeNull()
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValueOnce(true)
    expect(await historialInventario.autorizar(ctx, {})).toBeNull()
    expect(venueHasFeatureAccess).toHaveBeenCalledWith('v1', 'INVENTORY_TRACKING')
  })

  it('contar: suma las dos tablas hasta el corte, con los filtros de la pantalla', async () => {
    prismaMock.inventoryMovement.count.mockResolvedValue(120)
    prismaMock.rawMaterialMovement.count.mockResolvedValue(35)
    const corte = new Date('2026-11-12T00:00:00Z')

    expect(await historialInventario.contar('v1', { type: 'RECEIVED', search: 'har' }, corte)).toBe(155)

    const wp = prismaMock.inventoryMovement.count.mock.calls[0][0]!.where as any
    const wr = prismaMock.rawMaterialMovement.count.mock.calls[0][0]!.where as any
    expect(wp.AND).toEqual(expect.arrayContaining([{ createdAt: { lte: corte } }]))
    expect(wp.AND[0]).toMatchObject({ type: 'PURCHASE', inventory: { venueId: 'v1' } })
    expect(wr.AND[0]).toMatchObject({ type: 'PURCHASE', venueId: 'v1' })
  })

  it('🔴 tenant: las dos tablas filtran por el negocio', async () => {
    await historialInventario.pagina('v1', {}, new Date(), null, 500)
    const wp = prismaMock.inventoryMovement.findMany.mock.calls[0][0]!.where as any
    const wr = prismaMock.rawMaterialMovement.findMany.mock.calls[0][0]!.where as any
    expect(wp.AND[0]).toMatchObject({ inventory: { venueId: 'v1' } })
    expect(wr.AND[0]).toMatchObject({ venueId: 'v1' })
  })

  it('pagina: keyset y corte en las dos tablas, orden estable y tope por tabla', async () => {
    const corte = new Date('2026-11-12T00:00:00Z')
    const cursor = { createdAt: '2026-11-05T00:00:00.000Z', id: 'cz' }
    await historialInventario.pagina('v1', {}, corte, cursor, 500)

    for (const call of [
      prismaMock.inventoryMovement.findMany.mock.calls[0][0]!,
      prismaMock.rawMaterialMovement.findMany.mock.calls[0][0]!,
    ]) {
      const w = call.where as any
      expect(w.AND).toEqual(expect.arrayContaining([{ createdAt: { lte: corte } }, construirWhereKeyset(cursor)]))
      expect(call.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }])
      expect(call.take).toBe(500)
    }
  })

  it('pagina: mezcla por fecha y corta en el límite; el nombre de quien lo hizo sale del negocio', async () => {
    prismaMock.inventoryMovement.findMany.mockResolvedValue([
      movProducto('cp3', '2026-11-03T00:00:00Z'),
      movProducto('cp1', '2026-11-01T00:00:00Z'),
    ] as any)
    prismaMock.rawMaterialMovement.findMany.mockResolvedValue([
      movInsumo('ci2', '2026-11-02T00:00:00Z'),
      movInsumo('ci0', '2026-10-30T00:00:00Z'),
    ] as any)
    prismaMock.staff.findMany.mockResolvedValue([{ id: 'staff-1', firstName: 'Ana', lastName: 'Ruiz' }] as any)

    const p = await historialInventario.pagina('v1', {}, new Date(), null, 3)

    expect(p.map(r => r.id)).toEqual(['cp3', 'ci2', 'cp1'])
    expect(p[0]).toMatchObject({ staffName: 'Ana Ruiz', category: 'PRODUCT', totalCost: -20 })
    expect(p[1]).toMatchObject({ staffName: null, category: 'INGREDIENT', supplierName: 'Molinos', totalCost: 50 })
    const staffWhere = prismaMock.staff.findMany.mock.calls[0][0]!.where as any
    expect(staffWhere).toEqual({ id: { in: ['staff-1'] }, venues: { some: { venueId: 'v1' } } })
  })

  it('🔴 recorrer todas las páginas no repite ni pierde renglones (mezcla de dos tablas, con empates de fecha)', async () => {
    // Dos tablas «de verdad» en memoria: la consulta respeta corte, keyset, orden y take.
    const productos = [
      movProducto('cpa', '2026-11-05T00:00:00Z'),
      movProducto('cpb', '2026-11-04T00:00:00Z'),
      movProducto('cpc', '2026-11-04T00:00:00Z'), // empate con cpb y con un insumo
      movProducto('cpd', '2026-11-01T00:00:00Z'),
    ]
    const insumos = [
      movInsumo('cib', '2026-11-04T00:00:00Z'),
      movInsumo('cia', '2026-11-03T00:00:00Z'),
      movInsumo('cic', '2026-11-02T00:00:00Z'),
    ]
    const consulta = (tabla: any[]) => async (args: any) => {
      const ks = args.where.AND[2] as { OR?: [{ createdAt: { lt: Date } }, { createdAt: Date; id: { lt: string } }] }
      return tabla
        .filter(m => {
          if (!ks.OR) return true
          const t = ks.OR[0].createdAt.lt.getTime()
          return m.createdAt.getTime() < t || (m.createdAt.getTime() === t && m.id < ks.OR[1].id.lt)
        })
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
        .slice(0, args.take)
    }
    prismaMock.inventoryMovement.findMany.mockImplementation(consulta(productos) as any)
    prismaMock.rawMaterialMovement.findMany.mockImplementation(consulta(insumos) as any)

    const vistos: string[] = []
    let cursor: { createdAt: string; id: string } | null = null
    for (let vuelta = 0; vuelta < 10; vuelta++) {
      const p = await historialInventario.pagina('v1', {}, new Date(), cursor, 2)
      vistos.push(...p.map(r => r.id))
      if (p.length < 2) break
      cursor = historialInventario.cursorDe(p[p.length - 1])
    }

    expect(vistos).toEqual(['cpa', 'cpc', 'cpb', 'cib', 'cia', 'cic', 'cpd'])
    expect(new Set(vistos).size).toBe(7)
  })
})
