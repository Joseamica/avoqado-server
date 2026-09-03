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

describe('recordFastPayment — la orden FAST cae en el turno de caja del NEGOCIO', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    installFakes()
  })

  it('con turno abierto, la orden y su cobro llevan el MISMO shiftId', async () => {
    prismaMock.shift.findFirst.mockResolvedValue({ id: 'shift-negocio' })

    await recordFastPayment(VENUE, cobroRapido(), 'user-1')

    expect(datosDeLaOrden().shiftId).toBe('shift-negocio')
    // El mismo valor en los dos: si la orden volviera a consultar el turno por su cuenta, un
    // cierre de caja a media transacción los mandaría a turnos distintos.
    expect(datosDelCobro().shiftId).toBe('shift-negocio')
    // Y se resolvió por NEGOCIO, no por quien cobra (el selector «Vendedor» cambia ese staffId).
    expect(prismaMock.shift.findFirst).toHaveBeenCalledTimes(1)
    expect(prismaMock.shift.findFirst.mock.calls[0][0].where).toEqual({ venueId: VENUE, status: 'OPEN', endTime: null })
  })

  it('sin turno abierto la venta SIGUE ocurriendo, con la orden sin turno', async () => {
    // Un negocio que no abrió caja tiene que poder vender igual: el turno es opcional.
    prismaMock.shift.findFirst.mockResolvedValue(null)

    await recordFastPayment(VENUE, cobroRapido(), 'user-1')

    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
    expect(datosDeLaOrden().shiftId ?? null).toBeNull()
    expect(datosDelCobro().shiftId ?? null).toBeNull()
  })
})
