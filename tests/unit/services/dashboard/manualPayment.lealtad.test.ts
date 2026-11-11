import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { createManualPayment } from '@/services/dashboard/manualPayment.service'
import { awardLoyaltyForPaidOrder } from '@/services/shared/loyaltyOnPaidOrder'
import { earnPoints } from '@/services/dashboard/loyalty.dashboard.service'
import { updateCustomerMetrics } from '@/services/dashboard/customer.dashboard.service'

jest.mock('@/services/shared/loyaltyOnPaidOrder', () => ({
  awardLoyaltyForPaidOrder: jest.fn(async () => ({ complete: true, errors: [] })),
}))
jest.mock('@/services/dashboard/loyalty.dashboard.service', () => ({
  earnPoints: jest.fn(async () => ({ pointsEarned: 0, newBalance: 0 })),
}))
jest.mock('@/services/dashboard/customer.dashboard.service', () => ({ updateCustomerMetrics: jest.fn(async () => undefined) }))
jest.mock('@/services/mobile/areaTicketV7.mobile.service', () => ({ lockAreaTicketCheckoutHierarchy: jest.fn(async () => null) }))
jest.mock('@/services/tpv/paymentEffects.service', () => ({ enqueuePaymentCommissionInTx: jest.fn(async () => undefined) }))
jest.mock('@/services/inventory/inventoryPosting.service', () => ({ createSalePostingInTx: jest.fn(async () => null) }))
jest.mock('@/services/shared/cashDrawerPosting', () => ({ postCashSaleToDrawer: jest.fn(async () => undefined) }))
jest.mock('@/services/giftCards/giftCardLedger', () => ({ activarSobresDeCuentaPagadaEnTx: jest.fn(async () => undefined) }))
jest.mock('@/services/referrals/referralQualification.service', () => ({ onOrderPaid: jest.fn(async () => undefined) }))

const entrada = { orderId: 'o1', amount: '100', tipAmount: '0', method: 'CASH', source: 'OTHER' } as const
const cuenta = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  venueId: 'v1',
  status: 'PENDING',
  paymentStatus: 'PENDING',
  subtotal: new Prisma.Decimal(100),
  total: new Prisma.Decimal(100),
  taxAmount: new Prisma.Decimal(0),
  customerId: 'legacyA',
  payments: [],
  orderCustomers: [{ customerId: 'primaryA', isPrimary: true }],
  items: [],
  ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  ;(awardLoyaltyForPaidOrder as jest.Mock).mockResolvedValue({ complete: true, errors: [] })
  prismaMock.$transaction.mockImplementation(async (fn: any) => fn(prismaMock))
  prismaMock.$queryRaw.mockResolvedValue([{ id: 'o1' }])
  prismaMock.order.findFirst.mockResolvedValue(cuenta() as any)
  prismaMock.shift.findFirst.mockResolvedValue(null)
  prismaMock.payment.findUnique.mockResolvedValue(null)
  prismaMock.payment.count.mockResolvedValue(0)
  prismaMock.payment.create.mockResolvedValue({ id: 'p1' } as any)
  prismaMock.customer.findFirst.mockResolvedValue({ id: 'overrideB' } as any)
})

describe('pago manual · obligación durable y regla común (R-P2-S3-1)', () => {
  it('marca en la MISMA escritura PAID y delega tras el commit con legacy persistido, sin doble métrica', async () => {
    let dentro = true
    prismaMock.$transaction.mockImplementation(async (fn: any) => {
      const r = await fn(prismaMock)
      dentro = false
      return r
    })
    ;(awardLoyaltyForPaidOrder as jest.Mock).mockImplementation(async () => {
      expect(dentro).toBe(false)
      return { complete: true, errors: [] }
    })
    await createManualPayment('v1', 'staff1', { ...entrada, customerId: 'overrideB' })
    expect(prismaMock.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ paymentStatus: 'PAID', loyaltyEligibleAt: expect.any(Date), loyaltyStaffId: 'staff1' }),
      }),
    )
    expect(awardLoyaltyForPaidOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: 'v1',
        orderId: 'o1',
        staffId: 'staff1',
        orderTotal: 100,
        legacyCustomer: { id: 'legacyA', firstName: null, lastName: null },
      }),
    )
    expect(earnPoints).not.toHaveBeenCalled()
    expect(updateCustomerMetrics).not.toHaveBeenCalled()
  })

  it('parcial no deja obligación ni otorga', async () => {
    await createManualPayment('v1', 'staff1', { ...entrada, amount: '25' })
    expect(prismaMock.order.update.mock.calls[0][0].data).not.toHaveProperty('loyaltyEligibleAt')
    expect(awardLoyaltyForPaidOrder).not.toHaveBeenCalled()
  })

  it('ya PAID se rechaza sin nueva obligación', async () => {
    prismaMock.order.findFirst.mockResolvedValue(cuenta({ paymentStatus: 'PAID' }) as any)
    await expect(createManualPayment('v1', 'staff1', entrada)).rejects.toMatchObject({ code: 'ORDER_ALREADY_PAID' })
    expect(prismaMock.order.update).not.toHaveBeenCalled()
    expect(awardLoyaltyForPaidOrder).not.toHaveBeenCalled()
  })

  it('sin legacy, el override sólo crea la liga primaria actual; no se convierte en fallback', async () => {
    prismaMock.order.findFirst.mockResolvedValue(cuenta({ customerId: null, orderCustomers: [] }) as any)
    await createManualPayment('v1', 'staff1', { ...entrada, customerId: 'overrideB' })
    expect(prismaMock.orderCustomer.create).toHaveBeenCalledWith({ data: { orderId: 'o1', customerId: 'overrideB', isPrimary: true } })
    expect(awardLoyaltyForPaidOrder).toHaveBeenCalledWith(expect.objectContaining({ legacyCustomer: null }))
  })
  it('[repetirNoDuplica:createManualPayment] sólo publica cliente y efectos del intento ganador', async () => {
    let intento = 0
    prismaMock.order.findFirst.mockImplementation(async () => cuenta({ customerId: intento === 1 ? 'abortado' : 'ganador' }) as any)
    prismaMock.$transaction.mockImplementation(async (fn: any) => {
      intento++
      const r = await fn(prismaMock)
      if (intento === 1) throw Object.assign(new Error('deadlock detected'), { code: '40P01' })
      return r
    })
    await createManualPayment('v1', 'staff1', entrada)
    expect(intento).toBe(2)
    expect(awardLoyaltyForPaidOrder).toHaveBeenCalledTimes(1)
    expect(awardLoyaltyForPaidOrder).toHaveBeenCalledWith(
      expect.objectContaining({ legacyCustomer: { id: 'ganador', firstName: null, lastName: null } }),
    )
    expect(updateCustomerMetrics).not.toHaveBeenCalled()
  })
})
