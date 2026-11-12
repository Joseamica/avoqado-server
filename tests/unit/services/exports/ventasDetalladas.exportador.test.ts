jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: jest.fn(async () => true) }))
jest.mock('@/services/dashboard/salesSummaryPlanRange', () => ({
  ...jest.requireActual('@/services/dashboard/salesSummaryPlanRange'),
  rangoBloqueadoPorPlan: jest.fn(async () => false),
}))

import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { rangoBloqueadoPorPlan, PLAN_LIMIT_RANGE_CODE } from '@/services/dashboard/salesSummaryPlanRange'
import { construirWhereKeyset } from '@/services/exports/exportadores/comun'
import { ventasDetalladas, VENTAS_DETALLADAS_COLUMNAS } from '@/services/exports/exportadores/ventasDetalladas.exportador'
import { obtenerExportador } from '@/services/exports/exportadores/registry'

const ctx = { venueId: 'v1', staffId: 's1', esSuperadmin: false }
const filtros = { startDate: '2026-10-01T06:00:00.000Z', endDate: '2026-11-01T05:59:59.999Z' }

describe('exportador ventas-detalladas', () => {
  beforeEach(() => {
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(true)
    ;(rangoBloqueadoPorPlan as jest.Mock).mockResolvedValue(false)
  })

  it('keyset desc: después de (t, id) trae createdAt < t, o = t con id < id', () => {
    expect(construirWhereKeyset({ createdAt: '2026-09-15T10:00:00.000Z', id: 'cm5' })).toEqual({
      OR: [
        { createdAt: { lt: new Date('2026-09-15T10:00:00.000Z') } },
        { createdAt: new Date('2026-09-15T10:00:00.000Z'), id: { lt: 'cm5' } },
      ],
    })
  })
  it('sin cursor no agrega condición', () => {
    expect(construirWhereKeyset(null)).toEqual({})
  })
  it('paginar sobre empates de createdAt no duplica ni salta', async () => {
    const t = new Date('2026-09-15T10:00:00.000Z')
    const filas = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, createdAt: t })) // 5 con el MISMO instante
    const fakePagina = async (despuesDe: { createdAt: string; id: string } | null, limite: number) =>
      filas
        .filter(
          f =>
            !despuesDe ||
            f.createdAt < new Date(despuesDe.createdAt) ||
            (+f.createdAt === +new Date(despuesDe.createdAt) && f.id < despuesDe.id),
        )
        .sort((x, y) => +y.createdAt - +x.createdAt || (y.id < x.id ? -1 : 1))
        .slice(0, limite)
    const vistos: string[] = []
    let cursor: { createdAt: string; id: string } | null = null
    for (;;) {
      const p = await fakePagina(cursor, 2)
      if (p.length === 0) break
      vistos.push(...p.map(f => f.id))
      cursor = ventasDetalladas.cursorDe(p[p.length - 1] as never)
    }
    expect(vistos).toEqual(['e', 'd', 'c', 'b', 'a'])
  })
  it('las columnas son las mismas 13 del exporte de hoy, en el mismo orden', () => {
    expect(VENTAS_DETALLADAS_COLUMNAS.map(c => c.id)).toEqual([
      'createdAt',
      'paymentId',
      'waiterName',
      'merchantAccount',
      'method',
      'cardBrand',
      'last4',
      'international',
      'amount',
      'tipAmount',
      'totalAmount',
      'status',
      'source',
    ])
  })
  it('total = subtotal + propina; últimos 4 del maskedPan', () => {
    const fila = {
      id: 'p1',
      createdAt: new Date('2026-09-01T12:00:00Z'),
      amount: '145.5',
      tipAmount: '14.5',
      maskedPan: '411111******1234',
      processorData: { isInternational: true },
    } as never
    const col = (id: string) => VENTAS_DETALLADAS_COLUMNAS.find(c => c.id === id)!.value(fila)
    expect(col('totalAmount')).toBe(160)
    expect(col('last4')).toBe('1234')
    expect(col('international')).toBe('Sí')
  })
  it('parsearFiltros exige fechas, valida el método y acepta su propia salida', () => {
    expect(() => ventasDetalladas.parsearFiltros({})).toThrow(/startDate/)
    expect(() => ventasDetalladas.parsearFiltros({ ...filtros, endDate: 'y' })).toThrow(/La fecha de fin no es válida/)
    expect(() => ventasDetalladas.parsearFiltros({ ...filtros, paymentMethod: 'BITCOIN' })).toThrow(/paymentMethod/)
    expect(() => ventasDetalladas.parsearFiltros({ ...filtros, paymentMethod: 'QR_LEGACY' })).toThrow(/QR_LEGACY/)
    const una = ventasDetalladas.parsearFiltros({ ...filtros, staffIds: 'a,b', shiftId: ' t1 ' })
    expect(una).toMatchObject({ staffIds: ['a', 'b'], shiftId: 't1' })
    expect(ventasDetalladas.parsearFiltros(una)).toEqual(una)
  })
  it('autorizar: con TRANSACTION_EXPORT pasa', async () => {
    expect(await ventasDetalladas.autorizar(ctx, filtros)).toBeNull()
  })
  it('autorizar: sin TRANSACTION_EXPORT ⇒ el 403 de feature-gate de hoy', async () => {
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(false)
    expect(await ventasDetalladas.autorizar(ctx, filtros)).toEqual({
      status: 403,
      body: expect.objectContaining({ featureCode: 'TRANSACTION_EXPORT', subscriptionRequired: true }),
    })
    expect(await ventasDetalladas.autorizar({ ...ctx, esSuperadmin: true }, filtros)).toBeNull()
  })
  it('autorizar: plan Gratis fuera de «hoy» ⇒ 403 PLAN_LIMIT_RANGE, también para el superadmin (como el GET viejo)', async () => {
    ;(rangoBloqueadoPorPlan as jest.Mock).mockResolvedValue(true)
    const r = await ventasDetalladas.autorizar({ ...ctx, esSuperadmin: true }, filtros)
    expect(r).toEqual({ status: 403, body: expect.objectContaining({ code: PLAN_LIMIT_RANGE_CODE, featureCode: 'ADVANCED_REPORTS' }) })
    expect(rangoBloqueadoPorPlan).toHaveBeenCalledWith('v1', filtros.startDate, filtros.endDate)
  })
  it('está registrado', () => {
    expect(obtenerExportador('ventas-detalladas')?.kind).toBe('ventas-detalladas')
    expect(obtenerExportador('nope')).toBeNull()
    expect(obtenerExportador('__proto__')).toBeNull()
  })
})
