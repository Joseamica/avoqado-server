/**
 * 🔴 DISPONIBILIDAD DEL COBRO — P1.3 y P2.5 de la auditoría del 4-sep-2026.
 *
 * `getShifts` (la lista de turnos que la PAX consulta a diario) traía un `include` anidado SIN un
 * solo `take`: `shift.orders → payments → allocations` más `shift.payments`, y el `where` de las
 * órdenes era `undefined` cuando el cliente no mandaba fechas. Encima, `pageSize` venía del cliente
 * sin techo del servidor (`shift.tpv.controller.ts` sólo comprobaba `> 0`).
 *
 * Antes de la Fase 1 eso traía casi nada: 78 de 92 cobros de Testarudo (1-sep) tenían `shiftId`
 * nulo. Después, **un turno es un día entero del negocio** — el ledger reporta 128 órdenes y
 * $18,206.75 en UN turno—, así que la misma consulta pasó a materializar el día completo, con sus
 * cobros y sus asignaciones, × `pageSize` turnos. Es la clase de defecto que tumbó producción el
 * 1-sep (`include-sin-tope-en-un-detalle`), en el camino del cobro.
 *
 * Lo que consume la PAX de esta respuesta son AGREGADOS, nunca las listas: `ShiftDto`
 * (`avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/features/shift/data/dto/ShiftDto.kt:187`) no
 * declara `orders` ni `payments`, y `avoqado-desktop`
 * (`shared/src/commonMain/kotlin/com/avoqado/pos/core/model/ShiftModels.kt:60`) sí lee `tipsSum`,
 * `paymentSum` y `avgTipPercentage`. Por eso los totales se conservan con el MISMO nombre y el
 * MISMO valor, calculados con `aggregateShiftPayments`, y lo que desaparece es la hidratación.
 */

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    shift: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    payment: { findMany: jest.fn(), groupBy: jest.fn() },
    order: { count: jest.fn() },
    orderItem: { findMany: jest.fn(), aggregate: jest.fn() },
    rawMaterialMovement: { findMany: jest.fn() },
    venue: { findUnique: jest.fn() },
    staff: { findFirst: jest.fn() },
    activityLog: { create: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/communication/rabbitmq/publisher', () => ({ publishCommand: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn().mockReturnValue(null) } }))
jest.mock('@/services/access/cashReconciliationAccess.service', () => ({ isCashReconciliationEnabled: jest.fn() }))
jest.mock('@/services/dashboard/shift.dashboard.service', () => ({ resolveShiftCashDrawer: jest.fn().mockResolvedValue(null) }))

import prisma from '@/utils/prismaClient'
import { getCurrentShift, getShifts, TOPE_DE_TURNOS_POR_PAGINA } from '@/services/tpv/shift.tpv.service'

const m = prisma as unknown as {
  shift: { findMany: jest.Mock; count: jest.Mock; findFirst: jest.Mock }
  payment: { findMany: jest.Mock; groupBy: jest.Mock }
  order: { count: jest.Mock }
  orderItem: { aggregate: jest.Mock }
  venue: { findUnique: jest.Mock }
  $transaction: jest.Mock
}

const VENUE = 'venue-1'
const ABRE = new Date('2026-09-03T14:00:00.000Z')
const CIERRA = new Date('2026-09-03T22:00:00.000Z')

const turno = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  venueId: VENUE,
  staff: null,
  status: 'CLOSED',
  startTime: ABRE,
  endTime: CIERRA,
  updatedAt: CIERRA,
  ...extra,
})

function sembrar(turnos: any[], cobros: any[] = []) {
  m.$transaction.mockResolvedValue([turnos, turnos.length])
  m.shift.count.mockResolvedValue(turnos.length)
  m.venue.findUnique.mockResolvedValue(null)
  m.payment.findMany.mockResolvedValue(cobros)
}

beforeEach(() => jest.clearAllMocks())

describe('getShifts — el techo del `pageSize` lo pone el SERVIDOR', () => {
  it('🔴 un `pageSize` hostil se RECORTA al tope, no se obedece', async () => {
    sembrar([])

    const { meta } = await getShifts(VENUE, 100000, 1)

    expect(m.shift.findMany.mock.calls[0][0].take).toBe(TOPE_DE_TURNOS_POR_PAGINA)
    // `meta.pageSize` dice el valor APLICADO: el cliente pagina sobre lo que de verdad se sirvió.
    expect(meta.pageSize).toBe(TOPE_DE_TURNOS_POR_PAGINA)
  })

  it('se recorta, NO se rechaza: una PAX vieja que pida de más sigue viendo su pantalla', async () => {
    sembrar([])

    await expect(getShifts(VENUE, 100000, 1)).resolves.toBeDefined()
  })

  it('un `pageSize` normal pasa intacto', async () => {
    sembrar([])

    const { meta } = await getShifts(VENUE, 10, 1)

    expect(m.shift.findMany.mock.calls[0][0].take).toBe(10)
    expect(meta.pageSize).toBe(10)
  })

  it('el `skip` se calcula con el `pageSize` RECORTADO: si no, la página 2 se saltaría registros', async () => {
    sembrar([])

    await getShifts(VENUE, 100000, 2)

    expect(m.shift.findMany.mock.calls[0][0].skip).toBe(TOPE_DE_TURNOS_POR_PAGINA)
  })
})

describe('getShifts — la FORMA de la consulta: nada sin tope', () => {
  it('🔴 el `findMany` de turnos ya NO hidrata órdenes, cobros ni asignaciones', async () => {
    sembrar([])

    await getShifts(VENUE, 10, 1)

    const include = m.shift.findMany.mock.calls[0][0].include
    expect(include).toEqual({ staff: true })
    expect(include).not.toHaveProperty('orders')
    expect(include).not.toHaveProperty('payments')
  })

  it('🔴 el barrido de cobros va acotado: `take`, orden estable y cursor', async () => {
    sembrar([turno('turno-A')])

    await getShifts(VENUE, 10, 1)

    const args = m.payment.findMany.mock.calls[0][0]
    expect(typeof args.take).toBe('number')
    expect(args.take).toBeGreaterThan(0)
    expect(args.orderBy).toEqual({ id: 'asc' })
  })

  it('🔴 el barrido pide `venueId` y sólo cobros COMPLETED', async () => {
    sembrar([turno('turno-A')])

    await getShifts(VENUE, 10, 1)

    const where = m.payment.findMany.mock.calls[0][0].where
    expect(where.venueId).toBe(VENUE)
    expect(where.status).toBe('COMPLETED')
  })

  it('🔴 el `select` TRAE `shiftId`, `createdAt` y el `shiftId` de la orden', async () => {
    // Son los tres datos con los que se decide de quién es el cobro. Sin ellos, `turnoDelCobro`
    // falla cerrado — pero mejor que ni siquiera lleguemos ahí.
    sembrar([turno('turno-A')])

    await getShifts(VENUE, 10, 1)

    const select = m.payment.findMany.mock.calls[0][0].select
    expect(select.shiftId).toBe(true)
    expect(select.createdAt).toBe(true)
    expect(select.order).toEqual({ select: { shiftId: true } })
  })

  it('sin turnos en la página NO se barren cobros: no se paga por una pantalla vacía', async () => {
    sembrar([])

    await getShifts(VENUE, 10, 1)

    expect(m.payment.findMany).not.toHaveBeenCalled()
  })
})

describe('getShifts — el barrido se pagina y los totales se pliegan', () => {
  const cobro = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    shiftId: 'turno-A',
    amount: 1,
    tipAmount: 0,
    method: 'CASH',
    fundsFlow: null,
    tenderTypeId: null,
    tenderCountsAsCash: null,
    createdAt: new Date('2026-09-03T18:00:00.000Z'),
    order: { shiftId: 'turno-A' },
    ...extra,
  })

  it('🔴 con más cobros que una página, se sigue el cursor y se SUMAN las dos páginas', async () => {
    const primera = Array.from({ length: 500 }, (_, i) => cobro(`p-${String(i).padStart(4, '0')}`, { amount: 1, tipAmount: 1 }))
    const segunda = [cobro('p-9999', { amount: 40, tipAmount: 4 })]
    m.$transaction.mockResolvedValue([[turno('turno-A')], 1])
    m.shift.count.mockResolvedValue(1)
    m.venue.findUnique.mockResolvedValue(null)
    m.payment.findMany.mockResolvedValueOnce(primera).mockResolvedValueOnce(segunda)

    const { data } = await getShifts(VENUE, 10, 1)

    // 500 × $1 + $40. Si el plegado perdiera una página, saldría 500 o 40.
    expect(data[0].paymentSum).toBe(540)
    expect(data[0].tipsSum).toBe(504)
    expect(data[0].tipsCount).toBe(501)
    // La segunda llamada continúa DESDE el último id de la primera, sin repetirlo.
    expect(m.payment.findMany.mock.calls[1][0].cursor).toEqual({ id: 'p-0499' })
    expect(m.payment.findMany.mock.calls[1][0].skip).toBe(1)
  })

  it('una página incompleta termina el barrido: no se pide una vuelta de más', async () => {
    m.$transaction.mockResolvedValue([[turno('turno-A')], 1])
    m.shift.count.mockResolvedValue(1)
    m.venue.findUnique.mockResolvedValue(null)
    m.payment.findMany.mockResolvedValue([cobro('p-1', { amount: 100, tipAmount: 15 })])

    const { data } = await getShifts(VENUE, 10, 1)

    expect(m.payment.findMany).toHaveBeenCalledTimes(1)
    expect(data[0].paymentSum).toBe(100)
  })
})

describe('getCurrentShift — los totales se agregan en la BASE (P2.5)', () => {
  function sembrarTurnoAbierto(porMetodo: any[], productos: number | null = 7) {
    m.shift.findFirst.mockResolvedValue({ id: 'turno-abierto', venueId: VENUE, endTime: null, startTime: ABRE, status: 'OPEN' })
    m.payment.groupBy.mockResolvedValue(porMetodo)
    m.order.count.mockResolvedValue(3)
    m.orderItem.aggregate.mockResolvedValue({ _sum: { quantity: productos } })
  }

  const fila = (method: string, amount: number, tipAmount = 0) => ({ method, _sum: { amount, tipAmount } })

  it('🔴 ya no hidrata un `findMany` de cobros por cada sondeo de la PAX', async () => {
    sembrarTurnoAbierto([fila('CASH', 100, 10)])

    await getCurrentShift(VENUE)

    expect(m.payment.findMany).not.toHaveBeenCalled()
    expect(m.payment.groupBy).toHaveBeenCalledTimes(1)
  })

  it('🔴 la agregación va acotada por `venueId` y por cobros COMPLETED', async () => {
    sembrarTurnoAbierto([fila('CASH', 100)])

    await getCurrentShift(VENUE)

    expect(m.payment.groupBy.mock.calls[0][0].where).toEqual({ venueId: VENUE, shiftId: 'turno-abierto', status: 'COMPLETED' })
    expect(m.orderItem.aggregate.mock.calls[0][0].where.order).toMatchObject({ venueId: VENUE, shiftId: 'turno-abierto' })
  })

  it('el reparto por método es EL MISMO que hacía el bucle', async () => {
    sembrarTurnoAbierto([
      fila('CASH', 100, 10),
      fila('CREDIT_CARD', 200),
      fila('DEBIT_CARD', 50),
      fila('DIGITAL_WALLET', 30),
      fila('BANK_TRANSFER', 20),
      fila('OTHER', 5),
    ])

    const shift = await getCurrentShift(VENUE)

    expect(Number(shift!.totalCashPayments)).toBe(100)
    expect(Number(shift!.totalCardPayments)).toBe(250) // crédito + débito
    expect(Number(shift!.totalVoucherPayments)).toBe(30)
    expect(Number(shift!.totalOtherPayments)).toBe(25) // transferencia + otros
    expect(Number(shift!.totalSales)).toBe(405)
    expect(Number(shift!.totalTips)).toBe(10)
  })

  it('un método desconocido cae en «otros», igual que el `default` del bucle', async () => {
    sembrarTurnoAbierto([fila('LO_QUE_SEA', 77)])

    const shift = await getCurrentShift(VENUE)

    expect(Number(shift!.totalOtherPayments)).toBe(77)
  })

  it('un turno sin cobros da ceros, no revienta', async () => {
    sembrarTurnoAbierto([], null)

    const shift = await getCurrentShift(VENUE)

    expect(Number(shift!.totalSales)).toBe(0)
    // `_sum.quantity` es NULL cuando no hay renglones: no puede salir como `null` en la respuesta.
    expect(shift!.totalProductsSold).toBe(0)
  })

  it('la cantidad vendida sale de la suma de la base', async () => {
    sembrarTurnoAbierto([fila('CASH', 10)], 42)

    const shift = await getCurrentShift(VENUE)

    expect(shift!.totalProductsSold).toBe(42)
  })
})
