/**
 * La VENTA RÁPIDA da lealtad, igual que cualquier otro cobro.
 *
 * 🔴 El defecto (Amaena, 14-sep-2026): en el POS se escaneó la tarjeta de la clienta, la
 * pantalla dijo «0 de 8 sellos · esta compra le suma otro», se cobró $1.00 en efectivo como
 * venta rápida… y el sello nunca llegó. En producción la orden `FAST-1789419325852` quedó con
 * su cliente ligado, pero con `loyaltyEligibleAt` vacío, `loyaltyAttempts = 0`, sin
 * `StampEvent` y sin siquiera sumar la visita (`totalVisits = 0`).
 *
 * `recordFastPayment` no tocaba la lealtad por ningún lado. El cobro normal
 * (`updateOrderTotalsForStandalonePayment`) hace DOS cosas, y la venta rápida no hacía ninguna:
 *
 *   1. Marca la orden como apta (`loyaltyEligibleAt`) DENTRO de la transacción del dinero, para
 *      que el job `loyalty-reconciliation` la reintente si el paso 2 falla.
 *   2. Da la lealtad al momento con `awardLoyaltyForPaidOrder` DESPUÉS de comitear — que es lo
 *      que el POS le promete a la clienta en pantalla.
 *
 * No hay doble sello: `awardLoyaltyForPaidOrder` marca `loyaltyProcessedAt` al terminar, el job
 * sólo toma órdenes sin procesar, y `grantStamp` tiene índice único por orden.
 *
 * Andamiaje copiado de `payment.fastOrderTurno.test.ts`.
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
const ops: string[] = []
jest.mock('@/services/shared/loyaltyOnPaidOrder', () => ({
  __esModule: true,
  awardLoyaltyForPaidOrder: jest.fn(async () => {
    ops.push('awardLoyaltyForPaidOrder')
    return { complete: true, errors: [] }
  }),
}))

import prisma from '@/utils/prismaClient'
import { recordFastPayment } from '@/services/tpv/payment.tpv.service'
import { awardLoyaltyForPaidOrder } from '@/services/shared/loyaltyOnPaidOrder'

const prismaMock = prisma as any
const award = awardLoyaltyForPaidOrder as jest.Mock

// Reflejo ESTRECHO de la consulta fuente del outbox (`status: 'COMPLETED'` + `id` + `venueId`, seleccionando SOLO
// `orderId`): un reflejo laxo interceptaría búsquedas legítimas del servicio y le cambiaría el comportamiento.
const esConsultaDelOutbox = (a: any) =>
  a?.where?.status === 'COMPLETED' &&
  typeof a?.where?.id === 'string' &&
  'venueId' in (a?.where ?? {}) &&
  Object.keys(a?.select ?? {}).length === 1 &&
  a?.select?.orderId === true

const VENUE = 'venue-1'

/** Payload mínimo de una venta rápida en efectivo. Montos en centavos. */
function cobroRapido(extra: Record<string, unknown> = {}) {
  return {
    amount: 10000, // $100.00
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

function installFakes() {
  ops.length = 0
  prismaMock.order.create.mockImplementation(async ({ data }: any) => ({
    id: 'fast-order-1',
    venueId: VENUE,
    orderNumber: data.orderNumber,
    ...data,
  }))
  prismaMock.payment.create.mockImplementation(async ({ data }: any) => ({
    id: 'pay-1',
    feeAmount: 0,
    netAmount: 0,
    tipAmount: 0,
    processedBy: null,
    receipts: [],
    ...data,
  }))
  prismaMock.payment.findUnique.mockResolvedValue(null)
  // «No hay cobro previo» sigue siendo la respuesta a cualquier consulta… salvo a la del outbox de efectos
  // (`enqueuePaymentEffect`, dentro de la transacción del dinero en develop), que relee SU pago fuente para
  // comprobar que pertenece a la misma orden. Devolverle null ahí dispara PAYMENT_EFFECT_SOURCE_MISMATCH y
  // tumba la transacción del cobro entera. Mismo reflejo, igual de estrecho, que `payment.fastOrderTurno.test.ts`.
  prismaMock.payment.findFirst.mockImplementation(async (a: any) => (esConsultaDelOutbox(a) ? { orderId: a.where.orderId ?? null } : null))
  // El rescate de la comisión (bajo SAVEPOINT) relee el pago: se devuelve el que ESTE test acaba de crear.
  prismaMock.payment.findUniqueOrThrow.mockImplementation(async () => ({
    id: 'pay-1',
    venueId: VENUE,
    orderId: 'fast-order-1',
    status: 'COMPLETED',
    amount: 100,
    tipAmount: 0,
    feeAmount: 0,
    netAmount: 0,
    processedBy: null,
    receipts: [],
  }))
  prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vt-1' })
  prismaMock.paymentAllocation.create.mockResolvedValue({ id: 'alloc-1' })
  prismaMock.shift.findFirst.mockResolvedValue(null)
  prismaMock.shift.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.customer.findUnique.mockResolvedValue(null)
  prismaMock.order.findFirst.mockResolvedValue(null)
  prismaMock.order.update.mockResolvedValue({ id: 'fast-order-1' })
  prismaMock.activityLog.create.mockResolvedValue({ id: 'log-1' })
  prismaMock.cashDrawerSession = prismaMock.cashDrawerSession ?? {}
  prismaMock.cashDrawerSession.findFirst = jest.fn().mockResolvedValue(null)
  prismaMock.orderCustomer = prismaMock.orderCustomer ?? {}
  prismaMock.orderCustomer.findUnique = jest.fn().mockResolvedValue(null)
  prismaMock.orderCustomer.findFirst = jest.fn().mockResolvedValue(null)
  prismaMock.orderCustomer.findMany = jest.fn().mockResolvedValue([])
  prismaMock.orderCustomer.create = jest.fn().mockResolvedValue({ id: 'oc-1' })
  prismaMock.orderCustomer.update = jest.fn().mockResolvedValue({ id: 'oc-1' })
  prismaMock.terminalPaymentRequest.findUnique.mockResolvedValue(null)
  prismaMock.terminalPaymentRequest.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.order.findUnique.mockResolvedValue(null)
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1' })
  prismaMock.areaTicketInventoryReservation = prismaMock.areaTicketInventoryReservation ?? {}
  prismaMock.areaTicketInventoryReservation.findMany = jest.fn().mockResolvedValue([])
}

/**
 * Transacción con su PROPIO `order.update`, para distinguir la marca hecha dentro del dinero de
 * una hecha después: una marca fuera de la transacción se pierde si el proceso muere entre el
 * commit y ese update, y entonces ni el job la reintenta.
 */
function installTransaction() {
  const txOrderUpdate = jest.fn(async (args: any) => {
    ops.push('tx.order.update')
    return { id: args.where.id }
  })
  const tx = { ...prismaMock, order: { ...prismaMock.order, update: txOrderUpdate } }
  prismaMock.$transaction.mockImplementation(async (callback: any) => {
    const result = await callback(tx)
    ops.push('commit')
    return result
  })
  return { txOrderUpdate }
}

const marcaDeLealtad = (txOrderUpdate: jest.Mock) =>
  txOrderUpdate.mock.calls.map(c => c[0]).find((a: any) => a?.data && 'loyaltyEligibleAt' in a.data)

describe('recordFastPayment — la venta rápida da lealtad (Amaena, 14-sep-2026)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    installFakes()
  })

  it('marca la orden como apta para lealtad DENTRO de la transacción del dinero', async () => {
    const { txOrderUpdate } = installTransaction()

    await recordFastPayment(VENUE, cobroRapido(), 'user-1')

    const marca = marcaDeLealtad(txOrderUpdate)
    expect(marca).toBeDefined()
    expect(marca.where).toMatchObject({ id: 'fast-order-1' })
    expect(marca.data.loyaltyEligibleAt).toBeInstanceOf(Date)
    expect(marca.data.loyaltyStaffId).toBe('staff-1')
    expect(ops.indexOf('tx.order.update')).toBeLessThan(ops.indexOf('commit'))
  })

  it('da la lealtad DESPUÉS de comitear, con la orden, el negocio y quién cobró', async () => {
    installTransaction()

    await recordFastPayment(VENUE, cobroRapido(), 'user-1')

    expect(award).toHaveBeenCalledTimes(1)
    expect(award.mock.calls[0][0]).toMatchObject({ venueId: VENUE, orderId: 'fast-order-1', staffId: 'staff-1', orderTotal: 100 })
    expect(ops.indexOf('awardLoyaltyForPaidOrder')).toBeGreaterThan(ops.indexOf('commit'))
  })

  it('la propina NO genera lealtad: la base es el total menos la propina', async () => {
    installTransaction()

    await recordFastPayment(VENUE, cobroRapido({ amount: 10000, tip: 1500 }), 'user-1')

    expect(award.mock.calls[0][0].orderTotal).toBe(100)
  })

  it('un cobro que NO quedó completado no marca ni da lealtad', async () => {
    const { txOrderUpdate } = installTransaction()

    await recordFastPayment(VENUE, cobroRapido({ status: 'PENDING' }), 'user-1')

    expect(marcaDeLealtad(txOrderUpdate)).toBeUndefined()
    expect(award).not.toHaveBeenCalled()
  })
})
