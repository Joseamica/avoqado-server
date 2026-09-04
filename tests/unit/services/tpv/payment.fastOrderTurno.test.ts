/**
 * La orden de una VENTA RÁPIDA tiene que nacer atada al turno de caja del negocio.
 *
 * 🔴 El defecto (auditoría de Codex, 2-sep-2026): `recordFastPayment` resolvía el turno con
 * `turnoAbiertoDelNegocio` y se lo estampaba al `Payment`… pero NO a la `Order` que crea en la
 * misma transacción. Desde la fase 1, `getActiveShifts`
 * (`dashboard/shared-query.service.ts`) cuenta las órdenes de un turno agrupando por
 * `Order.shiftId`, así que un turno con diez ventas rápidas enseñaba el dinero correcto y
 * «0 órdenes»; el cierre del turno tampoco veía sus productos.
 *
 * El turno YA está resuelto arriba en esa función: el arreglo es reusar ESE valor, nunca
 * volver a consultarlo (dos lecturas pueden devolver turnos distintos si alguien cierra caja
 * en medio, y entonces el pago y su orden caerían en turnos diferentes).
 *
 * Andamiaje copiado de `fastPaymentCustomer.test.ts`, la suite que ya ejercita
 * `recordFastPayment` de verdad — el mock local de `payment.turnoDelNegocio.test.ts` sirve a
 * `recordOrderPayment`, que no crea órdenes.
 */
jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/utils/staff-venue.util', () => ({
  __esModule: true,
  validateStaffVenue: jest.fn().mockResolvedValue('staff-1'),
}))
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  default: { broadcastToVenue: jest.fn() },
  socketManager: { broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({
  __esModule: true,
  generateDigitalReceipt: jest.fn(),
}))
jest.mock('@/services/payments/transactionCost.service', () => ({
  __esModule: true,
  createTransactionCost: jest.fn(),
}))
jest.mock('@/services/dashboard/commission/commission-calculation.service', () => ({
  __esModule: true,
  createCommissionForPayment: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/dashboard/autoReorder.service', () => ({
  __esModule: true,
  runAutoReorderForVenue: jest.fn().mockResolvedValue({ ran: false }),
}))
jest.mock('@/services/referrals/referralQualification.service', () => ({
  __esModule: true,
  onOrderPaid: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  __esModule: true,
  createSalePostingInTx: jest.fn().mockResolvedValue({ id: 'posting-test', status: 'PENDING' }),
  applySalePosting: jest.fn(),
}))

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { recordFastPayment } from '@/services/tpv/payment.tpv.service'

const prismaMock = prisma as any

const VENUE = 'venue-1'
/** Payload mínimo de una venta rápida en efectivo. */
function cobroRapido(extra: Record<string, unknown> = {}) {
  return {
    amount: 10000, // $100.00 en centavos
    tip: 0,
    status: 'COMPLETED',
    method: 'CASH',
    source: 'TPV',
    splitType: 'FULLPAYMENT',
    staffId: 'staff-1',
    paidProductsId: [],
    currency: 'MXN',
    isInternational: false,
    ...extra,
  } as any
}

let orders: any[] = []
let payments: any[] = []

function installFakes() {
  orders = []
  payments = []

  prismaMock.order.create.mockImplementation(async ({ data }: any) => {
    const created = { id: `fast-order-${orders.length + 1}`, venueId: VENUE, orderNumber: data.orderNumber, ...data }
    orders.push(created)
    return created
  })
  prismaMock.payment.create.mockImplementation(async ({ data }: any) => {
    const created = {
      id: `pay-${payments.length + 1}`,
      feeAmount: 0,
      netAmount: 0,
      tipAmount: 0,
      processedBy: null,
      receipts: [],
      ...data,
    }
    payments.push(created)
    return created
  })
  prismaMock.payment.findUnique.mockResolvedValue(null)
  prismaMock.payment.findFirst.mockResolvedValue(null)
  prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vt-1' })
  prismaMock.paymentAllocation.create.mockResolvedValue({ id: 'alloc-1' })
  prismaMock.shift.findFirst.mockResolvedValue(null)
  prismaMock.shift.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.customer.findUnique.mockResolvedValue(null)
  prismaMock.order.findFirst.mockResolvedValue(null)
  prismaMock.order.update.mockResolvedValue({ id: 'fast-order-1' })
  prismaMock.activityLog.create.mockResolvedValue({ id: 'log-1' })
  // `cashDrawerSession` y `orderCustomer` no existen en el prismaMock compartido
  // (tests/__helpers__/setup.ts); se crean aquí en vez de tocar el helper global,
  // que usan ~200 suites.
  prismaMock.cashDrawerSession = prismaMock.cashDrawerSession ?? {}
  prismaMock.cashDrawerSession.findFirst = jest.fn().mockResolvedValue(null)
  prismaMock.orderCustomer = prismaMock.orderCustomer ?? {}
  prismaMock.orderCustomer.findUnique = jest.fn().mockResolvedValue(null)
  prismaMock.orderCustomer.findFirst = jest.fn().mockResolvedValue(null)
  prismaMock.orderCustomer.findMany = jest.fn().mockResolvedValue([])
  prismaMock.orderCustomer.create = jest.fn().mockResolvedValue({ id: 'oc-1' })
  prismaMock.orderCustomer.update = jest.fn().mockResolvedValue({ id: 'oc-1' })
  // Sólo para el camino de delegación (recordOrderPayment corre de verdad).
  prismaMock.terminalPaymentRequest.findUnique.mockResolvedValue(null)
  prismaMock.terminalPaymentRequest.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.order.findUnique.mockResolvedValue(null)
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1' })
  prismaMock.areaTicketInventoryReservation = prismaMock.areaTicketInventoryReservation ?? {}
  prismaMock.areaTicketInventoryReservation.findMany = jest.fn().mockResolvedValue([])
}

/** Lo que de verdad se persistió en la orden FAST y en su cobro. */
const datosDeLaOrden = () => prismaMock.order.create.mock.calls[0]?.[0]?.data
const datosDelCobro = () => prismaMock.payment.create.mock.calls[0]?.[0]?.data

function installDistinctTransaction(candidate: { id: string; status: string } | null, claimedCount = 1) {
  const ops: string[] = []
  const shiftFindFirst = jest.fn(async () => {
    ops.push('shift.findFirst')
    return candidate
  })
  const shiftUpdateMany = jest.fn(async () => {
    ops.push('shift.updateMany')
    return { count: claimedCount }
  })
  const activityCreate = jest.fn(async (args: any) => {
    ops.push('activityLog.create')
    return prismaMock.activityLog.create(args)
  })
  const orderCreate = jest.fn(async (args: any) => {
    ops.push('order.create')
    return prismaMock.order.create(args)
  })
  const paymentCreate = jest.fn(async (args: any) => {
    ops.push('payment.create')
    return prismaMock.payment.create(args)
  })
  const tx = {
    ...prismaMock,
    shift: { ...prismaMock.shift, findFirst: shiftFindFirst, updateMany: shiftUpdateMany },
    activityLog: { ...prismaMock.activityLog, create: activityCreate },
    order: { ...prismaMock.order, create: orderCreate },
    payment: { ...prismaMock.payment, create: paymentCreate },
  }
  prismaMock.$transaction.mockImplementation(async (callback: any) => callback(tx))
  return { ops, shiftFindFirst, shiftUpdateMany, activityCreate }
}

function installStatefulFastP2002Rollback() {
  const committed = {
    shift: { totalSales: 0, totalTips: 0, totalOrders: 0 },
    orders: [] as any[],
    loserPayments: [] as any[],
    activityLogs: [] as any[],
  }
  const attempted = { claims: 0, orders: 0 }
  const ops: string[] = []

  prismaMock.$transaction.mockImplementationOnce(async (callback: any) => {
    const staged = {
      shift: { ...committed.shift },
      orders: [...committed.orders],
      loserPayments: [...committed.loserPayments],
      activityLogs: [...committed.activityLogs],
    }
    const tx = {
      ...prismaMock,
      shift: {
        ...prismaMock.shift,
        findFirst: jest.fn(async () => {
          ops.push('shift.findFirst')
          return { id: 'shift-open', status: 'OPEN' }
        }),
        updateMany: jest.fn(async ({ data }: any) => {
          ops.push('shift.updateMany')
          attempted.claims += 1
          staged.shift.totalSales += Number(data.totalSales.increment)
          staged.shift.totalTips += Number(data.totalTips.increment)
          staged.shift.totalOrders += Number(data.totalOrders.increment)
          return { count: 1 }
        }),
      },
      order: {
        ...prismaMock.order,
        create: jest.fn(async ({ data }: any) => {
          ops.push('order.create')
          attempted.orders += 1
          const created = { id: 'fast-order-loser', venueId: VENUE, ...data }
          staged.orders.push(created)
          return created
        }),
      },
      payment: {
        ...prismaMock.payment,
        create: jest.fn(async () => {
          ops.push('payment.create:P2002')
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
            meta: { target: ['venueId', 'idempotencyKey'] },
          })
        }),
      },
      activityLog: {
        ...prismaMock.activityLog,
        create: jest.fn(async ({ data }: any) => {
          ops.push('activityLog.create')
          staged.activityLogs.push(data)
          return data
        }),
      },
    }

    const result = await callback(tx)
    committed.shift = { ...staged.shift }
    committed.orders = [...staged.orders]
    committed.loserPayments = [...staged.loserPayments]
    committed.activityLogs = [...staged.activityLogs]
    return result
  })

  return { committed, attempted, ops }
}

describe('recordFastPayment — la orden FAST cae en el turno de caja del NEGOCIO', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    installFakes()
  })

  it.each(['FAILED', 'PENDING'] as const)(
    'un Payment %s no es dinero capturado: Order/Payment quedan sin turno, claim ni anomalía post-cierre',
    async status => {
      const tx = installDistinctTransaction({ id: 'shift-open', status: 'OPEN' })

      await recordFastPayment(VENUE, cobroRapido({ status }), 'user-1')

      expect(datosDeLaOrden().shiftId ?? null).toBeNull()
      expect(datosDelCobro()).toMatchObject({ status, shiftId: null })
      expect(tx.shiftFindFirst).not.toHaveBeenCalled()
      expect(tx.shiftUpdateMany).not.toHaveBeenCalled()
      expect(tx.activityCreate).not.toHaveBeenCalled()
    },
  )

  it('snapshottea PENDING una vez aunque la Order mutile el body a COMPLETED antes de crear Payment', async () => {
    const mutablePaymentData: any = cobroRapido({ status: 'PENDING' })
    installDistinctTransaction({ id: 'shift-open', status: 'OPEN' })
    prismaMock.order.create.mockImplementationOnce(async ({ data }: any) => {
      mutablePaymentData.status = 'COMPLETED'
      const created = { id: 'fast-order-mutating', venueId: VENUE, orderNumber: data.orderNumber, ...data }
      orders.push(created)
      return created
    })

    await recordFastPayment(VENUE, mutablePaymentData, 'user-1')

    expect(datosDeLaOrden().shiftId ?? null).toBeNull()
    expect(datosDelCobro()).toMatchObject({ status: 'PENDING', shiftId: null })
  })

  it('resuelve y reclama dentro de tx ANTES de crear; la orden y el cobro llevan el MISMO ganador', async () => {
    // Si el servicio vuelve a leer antes de la transacción, tomaría este id obsoleto.
    prismaMock.shift.findFirst.mockResolvedValue({ id: 'shift-obsoleto', status: 'OPEN' })
    const tx = installDistinctTransaction({ id: 'shift-negocio', status: 'OPEN' })

    await recordFastPayment(VENUE, cobroRapido(), 'user-1')

    expect(datosDeLaOrden().shiftId).toBe('shift-negocio')
    // El mismo valor en los dos: si la orden volviera a consultar el turno por su cuenta, un
    // cierre de caja a media transacción los mandaría a turnos distintos.
    expect(datosDelCobro().shiftId).toBe('shift-negocio')
    expect(prismaMock.shift.findFirst).not.toHaveBeenCalled()
    expect(tx.shiftFindFirst).toHaveBeenCalledWith({
      where: { venueId: VENUE, endTime: null },
      orderBy: { startTime: 'desc' },
      select: { id: true, status: true },
    })
    expect(tx.shiftUpdateMany).toHaveBeenCalledWith({
      where: { id: 'shift-negocio', venueId: VENUE, status: 'OPEN', endTime: null },
      data: expect.objectContaining({
        totalSales: { increment: expect.anything() },
        totalTips: { increment: expect.anything() },
        totalOrders: { increment: 1 },
      }),
    })
    expect(prismaMock.shift.update).not.toHaveBeenCalled()
    expect(tx.ops.indexOf('shift.updateMany')).toBeLessThan(tx.ops.indexOf('order.create'))
    expect(tx.ops.indexOf('order.create')).toBeLessThan(tx.ops.indexOf('payment.create'))
  })

  it('sin turno la venta SIGUE ocurriendo, ambos ids quedan null y nace una anomalía atómica', async () => {
    // Un negocio que no abrió caja tiene que poder vender igual: el turno es opcional.
    const tx = installDistinctTransaction(null)

    await recordFastPayment(VENUE, cobroRapido(), 'user-1')

    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
    expect(datosDeLaOrden().shiftId ?? null).toBeNull()
    expect(datosDelCobro().shiftId ?? null).toBeNull()
    expect(tx.activityCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'PAYMENT_WITHOUT_SHIFT',
        entity: 'Payment',
        entityId: 'pay-1',
        staffId: 'staff-1',
        venueId: VENUE,
        data: expect.objectContaining({
          reason: 'NO_SHIFT',
          paymentId: 'pay-1',
          orderId: 'fast-order-1',
          channel: 'recordFastPayment',
          amountPesos: '100.00',
          tipPesos: '0.00',
        }),
      }),
    })
    expect(tx.ops.indexOf('payment.create')).toBeLessThan(tx.ops.indexOf('activityLog.create'))
  })

  it('si el cierre gana entre lectura y claim no muta CLOSED ni estampa el candidato obsoleto', async () => {
    prismaMock.shift.findFirst.mockResolvedValue({ id: 'shift-que-cerro', status: 'OPEN' })
    const tx = installDistinctTransaction({ id: 'shift-que-cerro', status: 'OPEN' }, 0)

    await recordFastPayment(VENUE, cobroRapido({ tip: 1234 }), 'user-1')

    expect(datosDeLaOrden().shiftId ?? null).toBeNull()
    expect(datosDelCobro().shiftId ?? null).toBeNull()
    expect(prismaMock.shift.update).not.toHaveBeenCalled()
    expect(tx.activityCreate.mock.calls[0][0].data.data).toMatchObject({
      reason: 'CLAIM_LOST',
      candidateShiftId: 'shift-que-cerro',
      channel: 'recordFastPayment',
      amountPesos: '100.00',
      tipPesos: '12.34',
    })
  })

  it('un reintento idempotente retorna antes de claim/audit y no vuelve a incrementar', async () => {
    prismaMock.payment.findUnique.mockResolvedValue({
      id: 'pay-winner',
      orderId: 'fast-order-winner',
      amount: 100,
      tipAmount: 0,
      method: 'CASH',
      status: 'COMPLETED',
      receipts: [],
    })
    const tx = installDistinctTransaction({ id: 'shift-open', status: 'OPEN' })

    const result: any = await recordFastPayment(VENUE, cobroRapido({ idempotencyKey: 'same-key' }), 'user-1')

    expect(result.id).toBe('pay-winner')
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(tx.shiftUpdateMany).not.toHaveBeenCalled()
    expect(tx.activityCreate).not.toHaveBeenCalled()
  })

  it('P2002 después de claim/Order revierte ambos y devuelve el Payment ganador sin anomalía del perdedor', async () => {
    const winner = {
      id: 'pay-winner',
      orderId: 'fast-order-winner',
      status: 'COMPLETED',
      amount: new Prisma.Decimal(100),
      tipAmount: new Prisma.Decimal(0),
      method: 'CASH',
      receipts: [],
      idempotencyKey: 'fast-p2002',
    }
    prismaMock.payment.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(winner)
    const rollback = installStatefulFastP2002Rollback()

    const result: any = await recordFastPayment(VENUE, cobroRapido({ idempotencyKey: 'fast-p2002' }), 'user-1')

    expect(result.id).toBe('pay-winner')
    expect(rollback.attempted).toEqual({ claims: 1, orders: 1 })
    expect(rollback.ops).toEqual(['shift.findFirst', 'shift.updateMany', 'order.create', 'payment.create:P2002'])
    expect(rollback.committed.shift).toEqual({ totalSales: 0, totalTips: 0, totalOrders: 0 })
    expect(rollback.committed.orders).toEqual([])
    expect(rollback.committed.loserPayments).toEqual([])
    expect(rollback.committed.activityLogs).toEqual([])
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })
})
