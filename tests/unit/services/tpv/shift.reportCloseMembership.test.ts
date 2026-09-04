/**
 * 🔴 DINERO — Task 5q: la fila del reporte y el cierre firman el MISMO conjunto.
 *
 * Roturas que este archivo debe cazar:
 * - volver a cerrar sólo con `Payment.shiftId` y esconder huérfanos pos-sync legítimos;
 * - adoptar huérfanos de otro venue/turno o posteriores al instante del claim;
 * - recortar el barrido del cierre a una sola página o consultar Payments sin `take`;
 * - sumar el reporte con `number` y volver a exponer 0.30000000000000004;
 * - convertir la lectura del cierre en un backfill silencioso de `Payment.shiftId`.
 */

import { Decimal } from '@prisma/client/runtime/library'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    shift: {
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    payment: { findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    order: { count: jest.fn() },
    orderItem: { findMany: jest.fn() },
    rawMaterialMovement: { findMany: jest.fn() },
    staffVenue: { findFirst: jest.fn() },
    review: { count: jest.fn() },
    venue: { findUnique: jest.fn() },
    staff: { findFirst: jest.fn() },
    activityLog: { create: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/communication/rabbitmq/publisher', () => ({ publishCommand: jest.fn() }))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn().mockReturnValue(null) },
}))
jest.mock('@/services/access/cashReconciliationAccess.service', () => ({
  isCashReconciliationEnabled: jest.fn().mockResolvedValue(false),
}))
jest.mock('@/services/dashboard/shift.dashboard.service', () => ({
  resolveShiftCashDrawer: jest.fn().mockResolvedValue(null),
}))
jest.mock('@/services/shared/turnoDeCaja', () => ({
  __esModule: true,
  abrirTurnoDeCaja: jest.fn(),
  cerrarTurnoDeCaja: jest.fn().mockResolvedValue({ conConteo: false }),
  esperadoDelCajonAbierto: jest.fn().mockResolvedValue(null),
}))
jest.mock('@/services/shared/parejaDeCierre', () => ({
  __esModule: true,
  asegurarLaLiga: jest.fn().mockResolvedValue(false),
}))

import prisma from '@/utils/prismaClient'
import { closeShiftForVenueWithResult, cobroSinTurnoPerteneceAlTurno, getShifts } from '@/services/tpv/shift.tpv.service'

const m = prisma as any
const VENUE = 'venue-5q'
const TURNO = 'turno-5q'
const INICIO = new Date('2026-09-03T14:00:00.000Z')
const CLAIMED_AT = new Date('2026-09-03T22:00:00.000Z')

const pago = (over: Record<string, unknown> = {}) => ({
  id: 'pago-base',
  venueId: VENUE,
  orderId: 'orden-turno',
  shiftId: TURNO,
  status: 'COMPLETED',
  amount: new Decimal('100.00'),
  tipAmount: new Decimal('0.00'),
  method: 'CASH',
  fundsFlow: null,
  tenderTypeId: null,
  tenderCountsAsCash: null,
  processedById: 'staff-1',
  createdAt: new Date('2026-09-04T01:00:00.000Z'),
  allocations: [],
  ...over,
})

function turnoAbierto() {
  return {
    id: TURNO,
    venueId: VENUE,
    staffId: 'staff-1',
    startTime: INICIO,
    endTime: null,
    status: 'OPEN',
    updatedAt: INICIO,
    startingCash: new Decimal('0.00'),
    externalId: null,
    venue: { posType: 'NONE', posStatus: 'NOT_INTEGRATED', name: 'Venue 5q' },
  }
}

let cierreEscrito: Record<string, unknown>

function prepararCierre() {
  const abierto = turnoAbierto()
  cierreEscrito = {}
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ pg_advisory_xact_lock: null }]),
    shift: {
      findFirst: jest.fn(async () => abierto),
      updateMany: jest.fn(async (args: any) => {
        cierreEscrito = args.data
        return { count: 1 }
      }),
      findUnique: jest.fn(async () => ({ ...abierto, ...cierreEscrito })),
    },
    activityLog: { create: jest.fn().mockResolvedValue({ id: 'audit-5q' }) },
  }

  m.shift.findFirst.mockResolvedValue(abierto)
  m.shift.updateMany.mockResolvedValue({ count: 1 })
  m.orderItem.findMany.mockResolvedValue([])
  m.rawMaterialMovement.findMany.mockResolvedValue([])
  m.staffVenue.findFirst.mockResolvedValue(null)
  m.$transaction.mockImplementation(async (arg: unknown) => {
    if (typeof arg === 'function') return (arg as (client: typeof tx) => unknown)(tx)
    throw new Error('La prueba de cierre no esperaba una transacción por arreglo')
  })
  return tx
}

function esperarMembresiaCanonica(args: any) {
  expect(args.where).toEqual({
    venueId: VENUE,
    status: 'COMPLETED',
    OR: [
      { shiftId: TURNO },
      {
        shiftId: null,
        createdAt: { gte: INICIO, lte: CLAIMED_AT },
        order: { venueId: VENUE, shiftId: TURNO },
      },
    ],
  })
  expect(args.select).toEqual({
    id: true,
    amount: true,
    tipAmount: true,
    method: true,
    fundsFlow: true,
    tenderTypeId: true,
    tenderCountsAsCash: true,
  })
  expect(args.orderBy).toEqual({ id: 'asc' })
  expect(args.take).toBe(500)
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('cierre — membresía canónica del reporte', () => {
  it('firma $100 exactos + $80 huérfanos de la orden dentro de [startTime, claimedAt]', async () => {
    prepararCierre()
    m.payment.findMany.mockResolvedValue([
      // La identidad estampada manda aunque el timestamp quede fuera de la ventana.
      pago({ id: 'exacto', amount: new Decimal('100.00'), createdAt: new Date('2026-09-04T01:00:00.000Z') }),
      // Respaldo histórico pos-sync, exactamente en el extremo inclusivo del claim.
      pago({ id: 'huerfano', shiftId: null, amount: new Decimal('80.00'), createdAt: CLAIMED_AT }),
    ])

    await closeShiftForVenueWithResult(VENUE, TURNO, {}, { now: () => CLAIMED_AT })

    esperarMembresiaCanonica(m.payment.findMany.mock.calls[0][0])
    expect((cierreEscrito.totalSales as Decimal).toFixed(2)).toBe('180.00')
    expect(cierreEscrito.endTime).toBe(CLAIMED_AT)
  })

  it('expresa los límites en SQL: COMPLETED, tenant, dos ramas, orden objetivo y ventana inclusiva', async () => {
    prepararCierre()
    m.payment.findMany.mockResolvedValue([])

    await closeShiftForVenueWithResult(VENUE, TURNO, {}, { now: () => CLAIMED_AT })

    const args = m.payment.findMany.mock.calls[0][0]
    esperarMembresiaCanonica(args)
    // `null` es intencional y literal: `undefined` no puede adoptar un huérfano.
    expect(args.where.OR[1].shiftId).toBeNull()
    expect(args.where.OR).not.toContainEqual({ shiftId: { not: TURNO } })
  })

  it('usa aggregateShiftPayments también para propina y refund negativo del huérfano', async () => {
    prepararCierre()
    m.payment.findMany.mockResolvedValue([
      pago({ id: 'venta', amount: new Decimal('100.00') }),
      pago({ id: 'huerfano', shiftId: null, amount: new Decimal('80.00'), tipAmount: new Decimal('8.00'), method: 'OTHER' }),
      pago({ id: 'refund', shiftId: null, amount: new Decimal('-20.00'), tipAmount: new Decimal('0.00'), method: 'OTHER' }),
    ])

    await closeShiftForVenueWithResult(VENUE, TURNO, {}, { now: () => CLAIMED_AT })

    expect((cierreEscrito.totalSales as Decimal).toFixed(2)).toBe('160.00')
    expect((cierreEscrito.totalTips as Decimal).toFixed(2)).toBe('8.00')
    expect((cierreEscrito.totalOtherPayments as Decimal).toFixed(2)).toBe('60.00')
  })

  it('recorre más de una página en orden estable, con cursor, take y sin duplicar cobros', async () => {
    prepararCierre()
    const primera = Array.from({ length: 500 }, (_, i) => pago({ id: `p-${String(i).padStart(3, '0')}`, amount: new Decimal('1.00') }))
    const segunda = [pago({ id: 'p-500', amount: new Decimal('1.00') })]
    m.payment.findMany.mockImplementation(async (args: any) => {
      esperarMembresiaCanonica(args)
      if (!args.cursor) {
        expect(args.skip).toBeUndefined()
        return primera
      }
      expect(args.cursor).toEqual({ id: 'p-499' })
      expect(args.skip).toBe(1)
      return segunda
    })

    await closeShiftForVenueWithResult(VENUE, TURNO, {}, { now: () => CLAIMED_AT })

    expect(m.payment.findMany).toHaveBeenCalledTimes(2)
    expect((cierreEscrito.totalSales as Decimal).toFixed(2)).toBe('501.00')
  })

  it('es una lectura: nunca actualiza ni backfillea Payment.shiftId', async () => {
    prepararCierre()
    m.payment.findMany.mockResolvedValue([pago({ id: 'huerfano', shiftId: null, amount: new Decimal('80.00') })])

    await closeShiftForVenueWithResult(VENUE, TURNO, {}, { now: () => CLAIMED_AT })

    expect(m.payment.update).not.toHaveBeenCalled()
    expect(m.payment.updateMany).not.toHaveBeenCalled()
  })
})

describe('reporte — misma aritmética Decimal y tenant scope', () => {
  function prepararReporte(turno: Record<string, unknown>) {
    m.$transaction.mockResolvedValue([[turno], 1])
  }

  it('la fila no filtrada muestra los mismos $180: exacto + huérfano dentro de ventana', async () => {
    const exacto = pago({ id: 'exacto', amount: new Decimal('100.00') })
    const huerfano = pago({ id: 'huerfano', shiftId: null, amount: new Decimal('80.00'), createdAt: CLAIMED_AT })
    prepararReporte({
      ...turnoAbierto(),
      endTime: CLAIMED_AT,
      status: 'CLOSED',
      staff: null,
      orders: [{ id: 'orden-turno', payments: [huerfano] }],
      payments: [exacto],
    })

    const { data } = await getShifts(VENUE, 20, 1)

    expect(data[0].paymentSum).toBe(180)
    const query = m.shift.findMany.mock.calls[0][0]
    expect(query.include.orders.include.payments.where).toMatchObject({ venueId: VENUE, status: 'COMPLETED' })
    expect(query.include.payments.where).toMatchObject({ venueId: VENUE, status: 'COMPLETED' })
  })

  it('no expone artefactos float: 0.1 + 0.2 se reporta como 0.3', async () => {
    prepararReporte({
      ...turnoAbierto(),
      endTime: CLAIMED_AT,
      staff: null,
      orders: [],
      payments: [pago({ id: 'decimal-1', amount: new Decimal('0.1') }), pago({ id: 'decimal-2', amount: new Decimal('0.2') })],
    })

    const { data } = await getShifts(VENUE, 20, 1)

    expect(data[0].paymentSum).toBe(0.3)
  })

  it('durante CLOSING usa exactamente updatedAt=claimedAt y firma la misma membresía paginada que el cierre', async () => {
    const exactos = Array.from({ length: 500 }, (_, i) =>
      pago({
        id: `exacto-${String(i).padStart(3, '0')}`,
        amount: new Decimal('1.00'),
        // La identidad estampada manda incluso fuera de la ventana.
        createdAt: new Date('2026-09-04T01:00:00.000Z'),
      }),
    )
    const enElClaim = pago({ id: 'huerfano-en-claim', shiftId: null, amount: new Decimal('80.00'), createdAt: CLAIMED_AT })
    const despuesDelClaim = pago({
      id: 'huerfano-despues-claim',
      shiftId: null,
      amount: new Decimal('90.00'),
      createdAt: new Date(CLAIMED_AT.getTime() + 1),
    })
    const enCierre = {
      ...turnoAbierto(),
      status: 'CLOSING',
      updatedAt: CLAIMED_AT,
      staff: null,
      orders: [{ id: 'orden-turno', payments: [enElClaim, despuesDelClaim] }],
      payments: exactos,
    }
    prepararReporte(enCierre)

    const { data } = await getShifts(VENUE, 20, 1)
    const totalDelReporte = data[0].paymentSum
    const query = m.shift.findMany.mock.calls[0][0]
    // Prisma trae todos los escalares cuando sólo hay `include`: status y updatedAt no pueden
    // desaparecer de la fila sin que esta guardia de forma detecte un `select` estrechado.
    expect(query.select).toBeUndefined()

    prepararCierre()
    m.payment.findMany.mockResolvedValueOnce([...exactos.slice(0, 499), enElClaim]).mockResolvedValueOnce([exactos[499]])

    await closeShiftForVenueWithResult(VENUE, TURNO, {}, { now: () => CLAIMED_AT })

    expect(m.payment.findMany).toHaveBeenCalledTimes(2)
    expect(totalDelReporte).toBe(580)
    expect((cierreEscrito.totalSales as Decimal).toFixed(2)).toBe('580.00')
    expect(totalDelReporte).toBe((cierreEscrito.totalSales as Decimal).toNumber())
  })
})

describe('respaldo huérfano — techo según el estado real del turno', () => {
  const huerfanoEn = (createdAt: Date) => ({ createdAt })

  it('CLOSING incluye el extremo claimedAt y excluye claimedAt + 1 ms', () => {
    const turno = { status: 'CLOSING', startTime: INICIO, endTime: null, updatedAt: CLAIMED_AT }

    expect(cobroSinTurnoPerteneceAlTurno(huerfanoEn(CLAIMED_AT), turno)).toBe(true)
    expect(cobroSinTurnoPerteneceAlTurno(huerfanoEn(new Date(CLAIMED_AT.getTime() + 1)), turno)).toBe(false)
  })

  it('sólo OPEN real queda sin techo', () => {
    expect(
      cobroSinTurnoPerteneceAlTurno(huerfanoEn(new Date(CLAIMED_AT.getTime() + 1)), {
        status: 'OPEN',
        startTime: INICIO,
        endTime: null,
        updatedAt: INICIO,
      }),
    ).toBe(true)
  })

  it('CLOSED conserva endTime como techo inclusivo, aunque updatedAt sea posterior', () => {
    const turno = {
      status: 'CLOSED',
      startTime: INICIO,
      endTime: CLAIMED_AT,
      updatedAt: new Date(CLAIMED_AT.getTime() + 60_000),
    }

    expect(cobroSinTurnoPerteneceAlTurno(huerfanoEn(CLAIMED_AT), turno)).toBe(true)
    expect(cobroSinTurnoPerteneceAlTurno(huerfanoEn(new Date(CLAIMED_AT.getTime() + 1)), turno)).toBe(false)
  })

  it.each([
    ['status ausente', { startTime: INICIO, endTime: null, updatedAt: CLAIMED_AT }],
    ['cutoff ausente', { status: 'CLOSING', startTime: INICIO, endTime: null }],
    ['cutoff inválido', { status: 'CLOSING', startTime: INICIO, endTime: null, updatedAt: 'no-es-fecha' }],
  ])('falla cerrado si %s', (_caso, turno) => {
    expect(cobroSinTurnoPerteneceAlTurno(huerfanoEn(INICIO), turno)).toBe(false)
  })
})
