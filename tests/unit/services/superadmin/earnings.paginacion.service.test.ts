/**
 * Ganancias de Avoqado (panel superadmin) — recorrido por páginas con cursor.
 *
 * query-guard 2026-09-08: `GET /superadmin/earnings/summary` y `/time-series` cargaban de
 * un jalón TODOS los `TransactionCost` del rango, cada uno con su pago→negocio y su
 * comercio→proveedor→reparto (un `include` anidado). Medido en producción: 3,772 filas por
 * llamada con el rango por defecto (el mes en curso), y crece con cada cobro con tarjeta.
 *
 * El motor `computeRevenueSplit` NO es lineal en el monto (redondea a dos decimales en
 * varios puntos por transacción), así que agrupar en SQL cambiaría centavos: la corrección
 * es recorrer por páginas, no agregar. Los números quedan idénticos.
 */
import { getEarningsSummary, getEarningsTimeSeries } from '@/services/superadmin/earnings.service'
import { computeRevenueSplit } from '@/services/payments/revenueShare.service'
import { prismaMock } from '@tests/__helpers__/setup'

const RANGO = { startDate: new Date('2026-09-01T00:00:00Z'), endDate: new Date('2026-09-30T23:59:59Z') }

/**
 * Lo que deja Avoqado en CADA transacción de prueba, con las comisiones ya con IVA
 * incluido (`preIva` divide entre 1.16):
 *   costo del proveedor  round2(1 / 1.16)          = 0.86
 *   cobro al negocio     round2(3 / 1.16)          = 2.59
 *   neto de Avoqado      round2(2.59 − 0.86)       = 1.73
 */
const NETO_POR_TRANSACCION = 1.73

/** Una fila de costo: sin config de reparto, todo el margen es de Avoqado (venueRate − providerRate). */
const costo = (i: number) => ({
  id: `tc${String(i).padStart(4, '0')}`,
  amount: 100,
  transactionType: 'CREDIT',
  providerRate: 0.01,
  venueRate: 0.03,
  createdAt: new Date('2026-09-10T18:00:00Z'),
  payment: { venue: { id: 'v1', name: 'Testarudo Cafe' } },
  merchantAccount: {
    id: 'm1',
    alias: null,
    displayName: 'Amaena - B',
    externalMerchantId: 'EXT1',
    provider: { id: 'p1', code: 'ANGELPAY', name: 'AngelPay' },
    merchantRevenueShare: null,
  },
})

/** Sin dinero en línea: el resto del resumen no es lo que se está probando aquí. */
function sinEcommerce() {
  prismaMock.$queryRaw.mockResolvedValue([])
  prismaMock.checkoutSession.aggregate.mockResolvedValue({ _count: 0, _sum: { amount: null, applicationFeeCents: null } })
  prismaMock.checkoutSession.findMany.mockResolvedValue([])
}

beforeEach(() => {
  prismaMock.transactionCost.findMany.mockReset()
  prismaMock.checkoutSession.findMany.mockReset()
  prismaMock.checkoutSession.aggregate.mockReset()
  prismaMock.$queryRaw.mockReset()
  sinEcommerce()
})

describe('getEarningsSummary — páginas de 500 con cursor', () => {
  it('una página llena pide la siguiente con cursor en el último id; el total cubre las 503 filas', async () => {
    const pagina1 = Array.from({ length: 500 }, (_, i) => costo(i))
    const pagina2 = [costo(500), costo(501), costo(502)]
    prismaMock.transactionCost.findMany.mockResolvedValueOnce(pagina1).mockResolvedValueOnce(pagina2)

    const r = await getEarningsSummary(RANGO)

    expect(prismaMock.transactionCost.findMany).toHaveBeenCalledTimes(2)
    const [primera, segunda] = prismaMock.transactionCost.findMany.mock.calls.map((c: any[]) => c[0])
    expect(primera).toMatchObject({ take: 500, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    expect(primera.cursor).toBeUndefined()
    expect(segunda).toMatchObject({ take: 500, cursor: { id: 'tc0499' }, skip: 1 })
    // El filtro y el include no cambian entre páginas: mismas filas, sólo repartidas.
    expect(primera.where).toEqual(segunda.where)
    expect(primera.where).toMatchObject({ createdAt: { gte: RANGO.startDate, lte: RANGO.endDate } })
    expect(primera.include).toEqual(segunda.include)

    expect(r.totals.transactions).toBe(503)
    expect(r.totals.terminalNet).toBeCloseTo(503 * NETO_POR_TRANSACCION, 2) // 870.19
    expect(r.totals.netProfit).toBeCloseTo(503 * NETO_POR_TRANSACCION, 2)
    expect(r.totals.volume).toBeCloseTo(50300, 2)
    expect(r.byVenue).toHaveLength(1)
    expect(r.byVenue[0]).toMatchObject({ venueId: 'v1', transactions: 503, terminalNet: 870.19 })
    expect(r.byMerchant[0]).toMatchObject({ merchantAccountId: 'm1', transactions: 503 })
    expect(r.byProvider[0]).toMatchObject({ providerCode: 'ANGELPAY', transactions: 503 })
  })

  it('regresión: menos de 500 filas es UNA consulta (un mock constante no puede ciclar)', async () => {
    prismaMock.transactionCost.findMany.mockResolvedValue([costo(0), costo(1)])
    const r = await getEarningsSummary(RANGO)
    expect(prismaMock.transactionCost.findMany).toHaveBeenCalledTimes(1)
    expect(r.totals.transactions).toBe(2)
    expect(r.totals.terminalNet).toBeCloseTo(2 * NETO_POR_TRANSACCION, 2) // 3.46
  })

  it('regresión: sin filas devuelve ceros y no revienta', async () => {
    prismaMock.transactionCost.findMany.mockResolvedValue([])
    const r = await getEarningsSummary(RANGO)
    expect(prismaMock.transactionCost.findMany).toHaveBeenCalledTimes(1)
    expect(r.totals).toMatchObject({ transactions: 0, terminalNet: 0, netProfit: 0, averageMargin: 0 })
    expect(r.byVenue).toEqual([])
  })

  it('regresión: el filtro por negocio sigue llegando al where en TODAS las páginas', async () => {
    prismaMock.transactionCost.findMany
      .mockResolvedValueOnce(Array.from({ length: 500 }, (_, i) => costo(i)))
      .mockResolvedValueOnce([costo(500)])
    await getEarningsSummary(RANGO, { venueId: 'v1' })
    for (const llamada of prismaMock.transactionCost.findMany.mock.calls) {
      expect(llamada[0].where).toMatchObject({ payment: { venueId: 'v1' } })
    }
  })
})

describe('getEarningsTimeSeries — páginas de 500 con cursor', () => {
  it('recorre los costos por páginas y suma cada día una sola vez', async () => {
    const pagina1 = Array.from({ length: 500 }, (_, i) => costo(i))
    const pagina2 = [costo(500), costo(501)]
    prismaMock.transactionCost.findMany.mockResolvedValueOnce(pagina1).mockResolvedValueOnce(pagina2)

    const puntos = await getEarningsTimeSeries(RANGO, 'daily')

    expect(prismaMock.transactionCost.findMany).toHaveBeenCalledTimes(2)
    expect(prismaMock.transactionCost.findMany.mock.calls[1][0]).toMatchObject({ cursor: { id: 'tc0499' }, skip: 1, take: 500 })
    expect(puntos).toHaveLength(1)
    expect(puntos[0]).toMatchObject({ date: '2026-09-10', terminalNet: 868.46, net: 868.46 }) // 502 × 1.73
  })

  it('los cobros en línea también se recorren por páginas y piden su id para el cursor', async () => {
    prismaMock.transactionCost.findMany.mockResolvedValue([])
    const sesion = (i: number) => ({
      id: `cs${String(i).padStart(4, '0')}`,
      createdAt: new Date('2026-09-11T12:00:00Z'),
      applicationFeeCents: 100,
    })
    prismaMock.checkoutSession.findMany
      .mockResolvedValueOnce(Array.from({ length: 500 }, (_, i) => sesion(i)))
      .mockResolvedValueOnce([sesion(500)])

    const puntos = await getEarningsTimeSeries(RANGO, 'daily')

    expect(prismaMock.checkoutSession.findMany).toHaveBeenCalledTimes(2)
    const [primera, segunda] = prismaMock.checkoutSession.findMany.mock.calls.map((c: any[]) => c[0])
    expect(primera.select.id).toBe(true)
    expect(segunda).toMatchObject({ cursor: { id: 'cs0499' }, skip: 1, take: 500 })
    expect(puntos[0]).toMatchObject({ date: '2026-09-11', onlineFees: 501, net: 501 })
  })

  it('regresión: con filtro por comercio NO se consultan los cobros en línea (no cuelgan de un comercio POS)', async () => {
    prismaMock.transactionCost.findMany.mockResolvedValue([costo(0)])
    await getEarningsTimeSeries(RANGO, 'daily', { merchantAccountId: 'm1' })
    expect(prismaMock.checkoutSession.findMany).not.toHaveBeenCalled()
  })
})

describe('por qué páginas y NO una agregación en SQL', () => {
  it('sumar los montos antes de repartir cambia el dinero: 870.19 fila por fila vs 867.24 agrupado', () => {
    const filaPorFila = 503 * NETO_POR_TRANSACCION

    // El mismo cálculo sobre el monto YA sumado, que es lo que haría un GROUP BY.
    const agrupado = computeRevenueSplit({
      amount: 503 * 100,
      cardType: 'CREDIT',
      providerCostRate: 0.01,
      providerCostIncludesTax: true,
      venueChargeRate: 0.03,
      venueChargeIncludesTax: true,
      share: null,
    }).avoqadoNet

    expect(filaPorFila).toBeCloseTo(870.19, 2)
    expect(agrupado).toBeCloseTo(867.24, 2)
    // 2.95 pesos de diferencia en 503 transacciones, y crece con el volumen: el redondeo a
    // dos decimales ocurre POR TRANSACCIÓN. Este es el candado de la decisión de diseño.
    expect(Math.abs(filaPorFila - agrupado)).toBeGreaterThan(2)
  })
})

describe('orden determinista de las tablas del resumen', () => {
  /** Dos negocios con EXACTAMENTE la misma ganancia, y tres tipos de tarjeta. */
  const filaDe = (i: number, venueId: string, venueName: string, tipo: string, monto: number) => ({
    ...costo(i),
    transactionType: tipo,
    amount: monto,
    payment: { venue: { id: venueId, name: venueName } },
  })

  it('empates y tipos de tarjeta salen SIEMPRE en el mismo orden, venga como venga la base', async () => {
    const filas = [
      filaDe(0, 'v-b', 'Bravo', 'CREDIT', 100),
      filaDe(1, 'v-a', 'Alfa', 'DEBIT', 100),
      filaDe(2, 'v-a', 'Alfa', 'AMEX', 500),
      filaDe(3, 'v-b', 'Bravo', 'AMEX', 500),
    ]
    prismaMock.transactionCost.findMany.mockResolvedValue(filas)
    const enOrden = await getEarningsSummary(RANGO)

    // La MISMA base devuelta al revés (sin ORDER BY, Postgres puede hacerlo) debe dar lo mismo.
    prismaMock.transactionCost.findMany.mockReset()
    sinEcommerce()
    prismaMock.transactionCost.findMany.mockResolvedValue([...filas].reverse())
    const alReves = await getEarningsSummary(RANGO)

    expect(alReves.byVenue).toEqual(enOrden.byVenue)
    expect(alReves.byCardType).toEqual(enOrden.byCardType)
    expect(alReves.byMerchant).toEqual(enOrden.byMerchant)
    expect(alReves.byProvider).toEqual(enOrden.byProvider)

    // Empate de ganancia entre Alfa y Bravo → desempata el id, no el azar.
    expect(enOrden.byVenue.map(v => v.venueId)).toEqual(['v-a', 'v-b'])
    expect(enOrden.byVenue[0].netProfit).toBe(enOrden.byVenue[1].netProfit)
    // Tipos de tarjeta por ganancia descendente (AMEX mueve 1,000; CREDIT y DEBIT 100 cada uno).
    expect(enOrden.byCardType.map(c => c.type)).toEqual(['AMEX', 'CREDIT', 'DEBIT'])
  })
})
