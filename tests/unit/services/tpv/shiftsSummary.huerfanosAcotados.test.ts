/**
 * El resumen de turnos de la TPV acota los pagos huérfanos cuando no hay fechas.
 *
 * Hallazgo del barrido post-incidente (2026-09-01): `getShiftsSummary` sin
 * startTime/endTime consultaba los pagos con `shiftId: null` SIN ninguna ventana.
 * Testarudo tiene 32,646 pagos huérfanos (importados de otro POS, sin turno):
 * una sola llamada sin fechas materializaba todos en el hilo único — la misma
 * clase de bomba que tumbó producción esa mañana con el detalle del venue.
 *
 * La regla que fijan estas pruebas: sin fechas, la rama de huérfanos se acota a
 * las últimas 24 horas (la pantalla de turnos de la PAX habla del día en curso).
 * Con fechas del cliente, se respetan tal cual — el comportamiento con fechas
 * no cambia ni un byte.
 */
import prisma from '@/utils/prismaClient'
import { getShiftsSummary } from '@/services/tpv/shift.tpv.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    shift: { findMany: jest.fn() },
    payment: { findMany: jest.fn() },
    order: { count: jest.fn() },
    review: { count: jest.fn() },
  },
}))

const m = prisma as unknown as {
  shift: { findMany: jest.Mock }
  payment: { findMany: jest.Mock }
  order: { count: jest.Mock }
  review: { count: jest.Mock }
}

beforeEach(() => {
  jest.clearAllMocks()
  m.shift.findMany.mockResolvedValue([])
  m.payment.findMany.mockResolvedValue([])
  m.order.count.mockResolvedValue(0)
  m.review.count.mockResolvedValue(0)
})

const ventanaDeHuerfanos = () => {
  expect(m.payment.findMany).toHaveBeenCalledTimes(1)
  return m.payment.findMany.mock.calls[0][0].where
}

describe('getShiftsSummary — pagos huérfanos acotados', () => {
  it('sin fechas, los huérfanos se acotan a las últimas 24 horas', async () => {
    const antes = Date.now()
    await getShiftsSummary('venue-1', {})
    const despues = Date.now()

    const where = ventanaDeHuerfanos()
    expect(where.shiftId).toBeNull()
    expect(where.createdAt?.gte).toBeInstanceOf(Date)
    const gte = (where.createdAt.gte as Date).getTime()
    // gte ≈ ahora − 24 h (tolerancia por el reloj del test)
    expect(gte).toBeGreaterThanOrEqual(antes - 24 * 60 * 60 * 1000 - 5000)
    expect(gte).toBeLessThanOrEqual(despues - 24 * 60 * 60 * 1000 + 5000)
  })

  it('con fechas del cliente, la ventana del cliente manda (sin cambios)', async () => {
    await getShiftsSummary('venue-1', { startTime: '2026-08-30T00:00:00.000Z', endTime: '2026-08-30T23:59:59.000Z' })

    const where = ventanaDeHuerfanos()
    expect(where.createdAt.gte).toEqual(new Date('2026-08-30T00:00:00.000Z'))
    expect(where.createdAt.lte).toEqual(new Date('2026-08-30T23:59:59.000Z'))
  })

  it('con sólo startTime, se respeta el startTime del cliente sin inventar lte', async () => {
    await getShiftsSummary('venue-1', { startTime: '2026-08-30T00:00:00.000Z' })

    const where = ventanaDeHuerfanos()
    expect(where.createdAt.gte).toEqual(new Date('2026-08-30T00:00:00.000Z'))
    expect(where.createdAt.lte).toBeUndefined()
  })

  it('sin fechas, los turnos ABIERTOS siguen entrando aunque empezaran hace días (solapan con la ventana)', async () => {
    await getShiftsSummary('venue-1', {})

    const whereShifts = m.shift.findMany.mock.calls[0][0].where
    expect(whereShifts.OR).toEqual(expect.arrayContaining([{ endTime: null }]))
  })
})

/**
 * P2 de la auditoría de Codex (2026-09-01): acotar SOLO los pagos huérfanos dejaba un
 * resumen con ventanas incompatibles — ventas de 24 h junto a conteos de órdenes y
 * reseñas de TODA la historia, y un dateRange null/null que no declaraba nada. La regla:
 * hay UNA ventana efectiva (la del cliente, o las últimas 24 h) y los tres conteos y el
 * dateRange la comparten.
 */
describe('getShiftsSummary — UNA ventana efectiva para todo el resumen', () => {
  const DIA_MS = 24 * 60 * 60 * 1000

  it('sin fechas, el conteo de órdenes huérfanas usa la MISMA ventana de 24 h', async () => {
    const antes = Date.now()
    await getShiftsSummary('venue-1', {})

    const whereOrdenes = m.order.count.mock.calls[0][0].where
    expect(whereOrdenes.createdAt?.gte).toBeInstanceOf(Date)
    const gte = (whereOrdenes.createdAt.gte as Date).getTime()
    expect(gte).toBeGreaterThanOrEqual(antes - DIA_MS - 5000)
    expect(gte).toBeLessThanOrEqual(Date.now() - DIA_MS + 5000)
  })

  it('sin fechas, el conteo de reseñas usa la MISMA ventana de 24 h', async () => {
    const antes = Date.now()
    await getShiftsSummary('venue-1', {})

    const whereResenas = m.review.count.mock.calls[0][0].where
    expect(whereResenas.createdAt?.gte).toBeInstanceOf(Date)
    const gte = (whereResenas.createdAt.gte as Date).getTime()
    expect(gte).toBeGreaterThanOrEqual(antes - DIA_MS - 5000)
    expect(gte).toBeLessThanOrEqual(Date.now() - DIA_MS + 5000)
  })

  it('sin fechas, dateRange DECLARA la ventana efectiva en vez de null/null', async () => {
    const res = await getShiftsSummary('venue-1', {})

    expect(res.dateRange.startTime).toBeInstanceOf(Date)
  })

  // P1 de la auditoría pre-push de Codex (2026-09-01): la ventana de 24 h se aplicaba a
  // huérfanos y reseñas pero NO a la rama de turnos — dateRange declaraba 24 h y los turnos
  // seguían otra regla (sólo abiertos, con TODO su historial de pagos). Ahora, sin fechas,
  // la ventana efectiva se fija ANTES de armar cualquier consulta y todas la comparten.
  it('sin fechas, la rama de TURNOS también usa la ventana de 24 h (solapan con el periodo, pagos dentro)', async () => {
    const antes = Date.now()
    await getShiftsSummary('venue-1', {})

    const whereShifts = m.shift.findMany.mock.calls[0][0].where
    // Con ventana, el OR trae más que { endTime: null }: la rama de solapamiento y la de pagos en el periodo.
    expect(whereShifts.OR.length).toBeGreaterThan(1)
    const inc = m.shift.findMany.mock.calls[0][0].include
    const gte = (inc.payments.where.createdAt.gte as Date).getTime()
    expect(gte).toBeGreaterThanOrEqual(antes - DIA_MS - 5000)
    expect(gte).toBeLessThanOrEqual(Date.now() - DIA_MS + 5000)
    const paymentOverlap = whereShifts.OR.find((branch: any) => branch.payments?.some)
    expect(paymentOverlap.payments.some.createdAt.gte).toBeInstanceOf(Date)
  })

  it('con sólo endTime, la ventana empieza 24 h ANTES de ese endTime (nunca gte > lte)', async () => {
    await getShiftsSummary('venue-1', { endTime: '2026-08-30T23:59:59.000Z' })

    const where = m.payment.findMany.mock.calls[0][0].where
    expect(where.createdAt.gte).toEqual(new Date(new Date('2026-08-30T23:59:59.000Z').getTime() - DIA_MS))
    expect(where.createdAt.lte).toEqual(new Date('2026-08-30T23:59:59.000Z'))
  })

  it('con fechas del cliente, órdenes y reseñas usan la ventana del cliente (sin cambios)', async () => {
    await getShiftsSummary('venue-1', { startTime: '2026-08-30T00:00:00.000Z', endTime: '2026-08-30T23:59:59.000Z' })

    expect(m.order.count.mock.calls[0][0].where.createdAt.gte).toEqual(new Date('2026-08-30T00:00:00.000Z'))
    expect(m.review.count.mock.calls[0][0].where.createdAt.gte).toEqual(new Date('2026-08-30T00:00:00.000Z'))
    expect(m.review.count.mock.calls[0][0].where.createdAt.lte).toEqual(new Date('2026-08-30T23:59:59.000Z'))
  })
})

/**
 * 🔴 LAS DOS MITADES DE `totalOrders` SE SUMAN, ASÍ QUE TIENEN QUE CONTAR LO MISMO.
 *
 * `totalOrders = Σ shift.orders.length + orphanOrderCount`. La primera mitad sale del `include` de
 * los turnos; la segunda, de un `order.count` aparte. Hasta el 3-sep-2026 daba igual que sus
 * predicados no coincidieran: casi ninguna orden llevaba `shiftId`, así que la mitad de los turnos
 * aportaba ~0 y el conteo lo cargaba entera la huérfana. Al estampar el turno al ABRIR la orden
 * (task 2b), esa mitad se llenó: sin el mismo filtro, las cuentas ABIERTAS y las CANCELADAS
 * empezarían a contar aquí —cuando no cuentan en la mitad huérfana— e inflarían un «total de
 * órdenes» que se lee justo al lado del total de ventas.
 *
 * El filtro `status: 'COMPLETED'` está puesto y bien comentado, pero no lo guardaba ninguna prueba:
 * un refactor podía desincronizar las mitades en silencio. Éstas lo fijan — el estado Y la ventana.
 */
describe('getShiftsSummary — las dos mitades de `totalOrders` usan el MISMO predicado', () => {
  const ordenesDelTurno = () => m.shift.findMany.mock.calls[0][0].include.orders.where
  const ordenesHuerfanas = () => m.order.count.mock.calls[0][0].where

  it('🔴 las órdenes del turno se filtran a COMPLETED, igual que las huérfanas', async () => {
    await getShiftsSummary('venue-1', {})

    expect(ordenesDelTurno().status).toBe('COMPLETED')
    expect(ordenesHuerfanas().status).toBe('COMPLETED')
    expect(ordenesDelTurno().status).toBe(ordenesHuerfanas().status)
  })

  it('🔴 sin fechas, las dos mitades usan la MISMA ventana efectiva', async () => {
    await getShiftsSummary('venue-1', {})

    expect(ordenesDelTurno().createdAt.gte).toEqual(ordenesHuerfanas().createdAt.gte)
    expect(ordenesDelTurno().createdAt.lte).toEqual(ordenesHuerfanas().createdAt.lte)
  })

  it('🔴 con fechas del cliente, las dos mitades usan la MISMA ventana del cliente', async () => {
    await getShiftsSummary('venue-1', { startTime: '2026-08-30T00:00:00.000Z', endTime: '2026-08-30T23:59:59.000Z' })

    expect(ordenesDelTurno().createdAt.gte).toEqual(new Date('2026-08-30T00:00:00.000Z'))
    expect(ordenesDelTurno().createdAt.lte).toEqual(new Date('2026-08-30T23:59:59.000Z'))
    expect(ordenesDelTurno().createdAt.gte).toEqual(ordenesHuerfanas().createdAt.gte)
    expect(ordenesDelTurno().createdAt.lte).toEqual(ordenesHuerfanas().createdAt.lte)
  })

  it('la mitad huérfana es la de las órdenes SIN turno (no se solapan ni se pierde ninguna)', async () => {
    await getShiftsSummary('venue-1', {})

    // Las dos mitades particionan: con turno (el `include`) y sin turno (`shiftId: null`).
    expect(ordenesHuerfanas().shiftId).toBeNull()
    expect(ordenesHuerfanas().venueId).toBe('venue-1')
  })
})
