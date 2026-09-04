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
    venueSettings: { findUnique: jest.fn() },
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
function transaccion(turnoAbierto: { id: string; status: string } | null, claimGana = true, enableShifts = true) {
  const orderCreate = jest.fn().mockResolvedValue({ id: 'shadow-1' })
  const paymentCreate = jest.fn().mockResolvedValue({ id: 'pay-1' })
  const shiftFindFirst = jest.fn().mockResolvedValue(turnoAbierto)
  const shiftUpdateMany = jest.fn().mockResolvedValue({ count: claimGana ? 1 : 0 })
  const shiftUpdate = jest.fn()
  const activityLogCreate = jest.fn().mockResolvedValue({ id: 'audit-1' })
  ;(prismaMock.venueSettings.findUnique as jest.Mock).mockResolvedValue({ enableShifts })
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (cb: any) =>
    cb({
      order: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn(), create: orderCreate },
      payment: { create: paymentCreate },
      shift: { findFirst: shiftFindFirst, update: shiftUpdate, updateMany: shiftUpdateMany },
      activityLog: { create: activityLogCreate },
      staffVenue: { findFirst: jest.fn().mockResolvedValue({ staffId: 'w1' }) },
      orderCustomer: { create: jest.fn() },
      venueTransaction: { create: jest.fn() },
      paymentAllocation: { create: jest.fn() },
    }),
  )
  return { orderCreate, paymentCreate, shiftFindFirst, shiftUpdateMany, shiftUpdate, activityLogCreate }
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
    const { orderCreate, paymentCreate, shiftFindFirst } = transaccion({ id: 'turno-negocio', status: 'OPEN' })

    await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, pagoSuelto)

    expect(orderCreate.mock.calls[0][0].data.shiftId).toBe('turno-negocio')
    expect(paymentCreate.mock.calls[0][0].data.shiftId).toBe('turno-negocio')
    // 🔴 Una sola lectura del turno: si la orden lo consultara por su cuenta, un cierre de caja
    // a media transacción mandaría orden y cobro a turnos distintos.
    expect(shiftFindFirst).toHaveBeenCalledTimes(1)
  })

  it('sin turno abierto el pago manual SIGUE ocurriendo, sin turno en ninguno', async () => {
    const { orderCreate, paymentCreate, activityLogCreate } = transaccion(null)

    await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, pagoSuelto)

    expect(orderCreate).toHaveBeenCalledTimes(1)
    expect(orderCreate.mock.calls[0][0].data.shiftId ?? null).toBeNull()
    expect(paymentCreate.mock.calls[0][0].data.shiftId ?? null).toBeNull()
    expect(activityLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'PAYMENT_WITHOUT_SHIFT',
        entity: 'Payment',
        entityId: 'pay-1',
        staffId: USER_ID,
        venueId: VENUE_ID,
        data: expect.objectContaining({
          reason: 'NO_SHIFT',
          channel: 'manualPayment',
          paymentId: 'pay-1',
          orderId: 'shadow-1',
          amountPesos: '500.00',
          tipPesos: '0.00',
          totalPesos: '500.00',
        }),
      }),
    })
  })

  it('🔴 el turno se RECLAMA con un `where` acotado, no se actualiza por id', async () => {
    // Era `shift.update({ where: { id } })`: sin `venueId` aceptaba el turno de OTRO negocio, y
    // sin `status` sumaba ventas a un turno ya CERRADO — reescribiendo un corte que alguien firmó.
    // Los tres rieles del turno usan ahora el MISMO claim condicional.
    const { shiftUpdateMany, shiftUpdate } = transaccion({ id: 'turno-negocio', status: 'OPEN' })

    await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, pagoSuelto)

    expect(shiftUpdate).not.toHaveBeenCalled()
    expect(shiftUpdateMany.mock.calls[0][0].where).toEqual({
      id: 'turno-negocio',
      venueId: VENUE_ID,
      status: 'OPEN',
      endTime: null,
    })
  })

  it('🔴 si el turno cerró entre la lectura y el claim, orden y cobro entran SIN turno', async () => {
    // Estampar el `shiftId` igual dejaría el cobro colgando de un turno al que nunca se le sumó:
    // un recálculo desde los pagos discreparía de su propio `totalSales`.
    const { orderCreate, paymentCreate, activityLogCreate } = transaccion({ id: 'turno-que-ya-cerro', status: 'OPEN' }, false)

    await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, pagoSuelto)

    expect(orderCreate.mock.calls[0][0].data.shiftId ?? null).toBeNull()
    expect(paymentCreate.mock.calls[0][0].data.shiftId ?? null).toBeNull()
    expect(activityLogCreate.mock.calls[0][0].data.data).toMatchObject({
      reason: 'CLAIM_LOST',
      candidateShiftId: 'turno-que-ya-cerro',
      observedShiftStatus: 'OPEN',
    })
  })

  it('un turno CLOSING conserva el pago sin turno y emite SHIFT_NOT_OPEN', async () => {
    const { paymentCreate, shiftUpdateMany, activityLogCreate } = transaccion({ id: 'turno-closing', status: 'CLOSING' })

    await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, pagoSuelto)

    expect(paymentCreate.mock.calls[0][0].data.shiftId ?? null).toBeNull()
    expect(shiftUpdateMany).not.toHaveBeenCalled()
    expect(activityLogCreate.mock.calls[0][0].data.data).toMatchObject({
      reason: 'SHIFT_NOT_OPEN',
      candidateShiftId: 'turno-closing',
      observedShiftStatus: 'CLOSING',
    })
  })

  it('con turnos apagados conserva el pago sin emitir falsa alarma', async () => {
    const { activityLogCreate } = transaccion(null, true, false)

    await manualPaymentService.createManualPayment(VENUE_ID, USER_ID, pagoSuelto)

    expect(activityLogCreate).not.toHaveBeenCalled()
  })

  it('si el Payment choca con P2002 no alcanza a escribir una alerta fantasma', async () => {
    const { paymentCreate, activityLogCreate } = transaccion(null)
    paymentCreate.mockRejectedValue(Object.assign(new Error('duplicate'), { code: 'P2002' }))

    await expect(manualPaymentService.createManualPayment(VENUE_ID, USER_ID, pagoSuelto)).rejects.toMatchObject({ code: 'P2002' })

    expect(activityLogCreate).not.toHaveBeenCalled()
  })
})
