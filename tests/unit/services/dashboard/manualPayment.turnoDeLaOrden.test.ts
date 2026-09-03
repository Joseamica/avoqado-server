/**
 * La orden SOMBRA de un pago manual cae en el MISMO turno que su `Payment`.
 *
 * 🔴 Contexto (3-sep-2026): la suite hermana `manualPayment.service.test.ts` ya fijaba que el
 * `Payment` lleve el turno abierto del negocio. La ORDEN que lo ancla no lo llevaba — y desde la
 * fase 1 del turno del negocio `getActiveShifts` cuenta las órdenes agrupando por `Order.shiftId`,
 * así que un pago manual sumaba dinero al turno sin sumar su orden.
 *
 * El valor se REUSA del que ya se resolvió arriba en la misma transacción; una segunda consulta
 * podría devolver otro turno si alguien cierra caja en medio, y entonces la orden y su cobro
 * caerían en turnos distintos.
 */
jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    order: { findFirst: jest.fn() },
    payment: { create: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
    staffVenue: { findFirst: jest.fn() },
    customer: { findFirst: jest.fn() },
    table: { findFirst: jest.fn() },
  },
}))
jest.mock('@/services/dashboard/loyalty.dashboard.service', () => ({
  __esModule: true,
  earnPoints: jest.fn().mockResolvedValue({ pointsEarned: 0, newBalance: 0 }),
}))
jest.mock('@/services/dashboard/customer.dashboard.service', () => ({
  __esModule: true,
  updateCustomerMetrics: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  __esModule: true,
  createSalePostingInTx: jest.fn().mockResolvedValue({ id: 'posting-mp-1', status: 'PENDING' }),
  applySalePosting: jest.fn().mockResolvedValue({ postingId: 'posting-mp-1', applied: true, issues: [] }),
}))
jest.mock('@/services/shared/cashDrawerPosting', () => ({
  __esModule: true,
  postCashSaleToDrawer: jest.fn(),
}))

import * as manualPaymentService from '@/services/dashboard/manualPayment.service'
import prisma from '@/utils/prismaClient'

const prismaMock = prisma as jest.Mocked<typeof prisma>
const VENUE_ID = 'venue-test-1'
const USER_ID = 'staff-test-1'

/** El cliente de transacción que ve el servicio, con los espías que interesan. */
function transaccion(turnoAbierto: { id: string } | null) {
  const orderCreate = jest.fn().mockResolvedValue({ id: 'shadow-1' })
  const paymentCreate = jest.fn().mockResolvedValue({ id: 'pay-1' })
  const shiftFindFirst = jest.fn().mockResolvedValue(turnoAbierto)
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (cb: any) =>
    cb({
      order: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn(), create: orderCreate },
      payment: { create: paymentCreate },
      shift: { findFirst: shiftFindFirst, update: jest.fn() },
      staffVenue: { findFirst: jest.fn().mockResolvedValue({ staffId: 'w1' }) },
      orderCustomer: { create: jest.fn() },
      venueTransaction: { create: jest.fn() },
      paymentAllocation: { create: jest.fn() },
    }),
  )
  return { orderCreate, paymentCreate, shiftFindFirst }
}

const pagoSuelto = { amount: '500.00', tipAmount: '0', method: 'CASH', source: 'OTHER', externalSource: 'BUQ' } as any

describe('createManualPayment — la orden sombra comparte turno con su cobro', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prismaMock.customer.findFirst as jest.Mock).mockResolvedValue({ id: 'customer-1' })
    ;(prismaMock.table.findFirst as jest.Mock).mockResolvedValue({ id: 'table-1' })
    ;(prismaMock.staffVenue.findFirst as jest.Mock).mockResolvedValue({ staffId: 'waiter-1', id: 'sv-1' })
  })

  it('con turno abierto, la orden sombra y el cobro llevan el MISMO turno', async () => {
    const { orderCreate, paymentCreate, shiftFindFirst } = transaccion({ id: 'turno-negocio' })

    await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, pagoSuelto)

    expect(orderCreate.mock.calls[0][0].data.shiftId).toBe('turno-negocio')
    expect(paymentCreate.mock.calls[0][0].data.shiftId).toBe('turno-negocio')
    // 🔴 Una sola lectura del turno: si la orden lo consultara por su cuenta, un cierre de caja
    // a media transacción mandaría orden y cobro a turnos distintos.
    expect(shiftFindFirst).toHaveBeenCalledTimes(1)
  })

  it('sin turno abierto el pago manual SIGUE ocurriendo, sin turno en ninguno', async () => {
    const { orderCreate, paymentCreate } = transaccion(null)

    await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, pagoSuelto)

    expect(orderCreate).toHaveBeenCalledTimes(1)
    expect(orderCreate.mock.calls[0][0].data.shiftId ?? null).toBeNull()
    expect(paymentCreate.mock.calls[0][0].data.shiftId ?? null).toBeNull()
  })
})
