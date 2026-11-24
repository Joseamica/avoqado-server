jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: jest.fn(async () => true) }))
jest.mock('@/services/dashboard/salesSummaryPlanRange', () => ({
  ...jest.requireActual('@/services/dashboard/salesSummaryPlanRange'),
  rangoBloqueadoPorPlan: jest.fn(async () => false),
}))

jest.mock('@/services/organization-payment-config.service', () => ({
  ...jest.requireActual('@/services/organization-payment-config.service'),
  getEffectivePaymentConfig: jest.fn(),
}))

import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { getEffectivePaymentConfig } from '@/services/organization-payment-config.service'
import { MENSAJE_COMERCIO_AJENO } from '@/services/venuePaymentConfig.service'
import { prismaMock } from '@tests/__helpers__/setup'
import { rangoBloqueadoPorPlan, PLAN_LIMIT_RANGE_CODE } from '@/services/dashboard/salesSummaryPlanRange'
import { construirWhereKeyset } from '@/services/exports/exportadores/comun'
import { ventasDetalladas, VENTAS_DETALLADAS_COLUMNAS } from '@/services/exports/exportadores/ventasDetalladas.exportador'
import { obtenerExportador } from '@/services/exports/exportadores/registry'
import PDFDocument from 'pdfkit'

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
  // D13.3: «Fecha» salía en UTC crudo («…T02:30:00.000Z» del día siguiente). Va la hora REAL, en la zona del negocio y legible.
  // Correr con TZ=UTC (como Render): la hora sale de la zona del negocio, nunca de la del proceso.
  it('🔴 D13.3 · «Fecha» es la hora real en la zona del negocio, no UTC', () => {
    const fecha = (fila: object) => VENTAS_DETALLADAS_COLUMNAS.find(c => c.id === 'createdAt')!.value(fila as never)
    // Cobro en línea de las 20:30 del 21 (CDMX) = 02:30 UTC del 22.
    expect(fecha({ createdAt: new Date('2026-11-22T02:30:00.000Z'), clientCreatedAt: null, zona: 'America/Mexico_City' })).toBe(
      '2026-11-21 20:30:00',
    )
    // Venta sin red de las 23:50 del 11 que subió a las 00:10 del 12: sale con la hora del aparato.
    expect(
      fecha({
        createdAt: new Date('2026-11-12T06:10:00.000Z'),
        clientCreatedAt: new Date('2026-11-12T05:50:00.000Z'),
        zona: 'America/Mexico_City',
      }),
    ).toBe('2026-11-11 23:50:00')
    // Otra zona: Tijuana va una hora antes que CDMX en noviembre (UTC−8).
    expect(fecha({ createdAt: new Date('2026-11-22T02:30:00.000Z'), clientCreatedAt: null, zona: 'America/Tijuana' })).toBe(
      '2026-11-21 18:30:00',
    )
    // Codex D13 r2 #1: una zona guardada fuera de IANA («GMT-6») no tumba el archivo: va la del negocio por default (CDMX).
    expect(fecha({ createdAt: new Date('2026-11-22T02:30:00.000Z'), clientCreatedAt: null, zona: 'GMT-6' })).toBe('2026-11-21 20:30:00')
  })

  // Codex D13 r1 #7: con las 13 columnas iguales, la fecha local (≈65 pt a 7 pt de letra) no cabía en 51.8 pt y se cortaba con «…».
  it('en el PDF de 13 columnas la fecha completa cabe en su celda (mismo reparto que encodePdf)', () => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 32 })
    const ancho = doc.page.width - 64
    const pesos = VENTAS_DETALLADAS_COLUMNAS.map(c => c.pdfAncho ?? 1)
    const celda = (ancho * pesos[0]) / pesos.reduce((a, p) => a + p, 0) - 8
    expect(doc.fontSize(7).widthOfString('2026-11-21 20:30:00')).toBeLessThanOrEqual(celda)
  })

  it('parsearFiltros exige fechas, valida el método y acepta su propia salida', () => {
    expect(() => ventasDetalladas.parsearFiltros({})).toThrow(/startDate/)
    expect(() => ventasDetalladas.parsearFiltros({ ...filtros, endDate: 'y' })).toThrow(/La fecha de fin no es válida/)
    expect(() => ventasDetalladas.parsearFiltros({ ...filtros, paymentMethod: 'BITCOIN' })).toThrow(/paymentMethod/)
    expect(() => ventasDetalladas.parsearFiltros({ ...filtros, paymentMethod: 'QR_LEGACY' })).toThrow(/QR anterior/)
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
  // Carril F (Codex r13): el exporte detallado en segundo plano comparte el filtro de comercio; una clave ajena ⇒ 400 en español.
  it('🔴 autorizar: un comercio que no es del negocio ⇒ 400 en español', async () => {
    ;(getEffectivePaymentConfig as jest.Mock).mockResolvedValue({ config: { primaryAccount: { id: 'clpropiosse0123456789012a' } } })
    ;(prismaMock.payment.findFirst as jest.Mock).mockResolvedValue(null)
    await expect(ventasDetalladas.autorizar(ctx, { ...filtros, merchantAccountId: 'clajenosse01234567890123a' })).rejects.toMatchObject({
      statusCode: 400,
      message: MENSAJE_COMERCIO_AJENO,
    })
    await expect(ventasDetalladas.autorizar(ctx, { ...filtros, merchantAccountId: 'clpropiosse0123456789012a' })).resolves.toBeNull()
  })
  it('está registrado', () => {
    expect(obtenerExportador('ventas-detalladas')?.kind).toBe('ventas-detalladas')
    expect(obtenerExportador('nope')).toBeNull()
    expect(obtenerExportador('__proto__')).toBeNull()
  })
})
