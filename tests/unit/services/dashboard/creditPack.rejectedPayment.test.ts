import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ __esModule: true, logAction: jest.fn() }))
jest.mock('@/services/public/customerBookingAccess.service', () => ({
  __esModule: true,
  assertCustomerCanCreateReservation: jest.fn(async () => undefined),
}))
// El servicio hace `new Stripe(...)` directo: se mockea el constructor del paquete.
const retrieveMock = jest.fn()
jest.mock('stripe', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ checkout: { sessions: { retrieve: retrieveMock } } })),
}))

import { logAction } from '@/services/dashboard/activity-log.service'

/**
 * Fase 1 — 🔴 hallazgo #2 de la auditoría de Codex.
 *
 * El gate corre ANTES de crear la sesión de Stripe, así que a alguien ya rechazado no se le
 * abre el cobro. Pero la URL de una sesión creada antes del rechazo sobrevive ~24 h: si el
 * negocio rechaza en medio, esa persona todavía puede pagar.
 *
 * Decisión: **se le acredita igual** — el dinero ya salió de su tarjeta y quedárselo sin dar
 * nada es peor que cualquier alternativa. Lo que NO puede pasar es que ocurra en silencio.
 * Esta suite vigila el rastro; sin él, el negocio nunca se entera y no puede decidir si
 * reembolsa o reconsidera.
 */
describe('paquete pagado por un cliente ya RECHAZADO', () => {
  beforeEach(() => jest.clearAllMocks())

  it('🔴 se acredita, pero deja rastro en la bitácora del negocio', async () => {
    retrieveMock.mockResolvedValue({
      metadata: { type: 'credit_pack_purchase', venueId: 'venue-1', packId: 'pack-1', customerId: 'cust-1' },
      payment_status: 'paid',
      amount_total: 150000,
      payment_intent: 'pi_1',
    })

    prismaMock.creditPackPurchase.findUnique.mockResolvedValue(null as any)
    prismaMock.creditPack.findFirst.mockResolvedValue({ id: 'pack-1', venueId: 'venue-1', validityDays: null, items: [] } as any)
    prismaMock.customer.findFirst.mockResolvedValue({ id: 'cust-1', venueId: 'venue-1', approvalStatus: 'REJECTED' } as any)
    ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
    prismaMock.creditPackPurchase.create.mockResolvedValue({ id: 'purchase-1', venueId: 'venue-1' } as any)

    const { fulfillPurchase } = await import('@/services/dashboard/creditPack.public.service')
    await fulfillPurchase('cs_test_1').catch(() => undefined)

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CREDIT_PACK_PAID_BY_REJECTED_CUSTOMER',
        entity: 'Customer',
        entityId: 'cust-1',
        venueId: 'venue-1',
      }),
    )
  })

  it('un cliente APROBADO no genera ese rastro (sería ruido en la bitácora)', async () => {
    retrieveMock.mockResolvedValue({
      metadata: { type: 'credit_pack_purchase', venueId: 'venue-1', packId: 'pack-1', customerId: 'cust-1' },
      payment_status: 'paid',
      amount_total: 150000,
      payment_intent: 'pi_1',
    })

    prismaMock.creditPackPurchase.findUnique.mockResolvedValue(null as any)
    prismaMock.creditPack.findFirst.mockResolvedValue({ id: 'pack-1', venueId: 'venue-1', validityDays: null, items: [] } as any)
    prismaMock.customer.findFirst.mockResolvedValue({ id: 'cust-1', venueId: 'venue-1', approvalStatus: 'APPROVED' } as any)
    ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
    prismaMock.creditPackPurchase.create.mockResolvedValue({ id: 'purchase-1', venueId: 'venue-1' } as any)

    const { fulfillPurchase } = await import('@/services/dashboard/creditPack.public.service')
    await fulfillPurchase('cs_test_1').catch(() => undefined)

    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'CREDIT_PACK_PAID_BY_REJECTED_CUSTOMER' }))
  })
})
