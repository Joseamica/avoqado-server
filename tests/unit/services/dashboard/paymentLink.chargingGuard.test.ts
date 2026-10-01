/**
 * 🔴 Auditoría 2026-09-30: una liga de un solo uso sólo se bloqueaba al COMPLETAR un pago (`paymentCount`). Con un cobro en
 * vuelo de resultado desconocido (S1 en CHARGING), el reintento del cliente abría S2 y podía cobrar dos veces.
 */
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
const mockTokenizeCard = jest.fn()
jest.mock('@/services/payments/provider-registry', () => ({
  getProvider: () => ({ tokenizeCard: (...a: unknown[]) => mockTokenizeCard(...a) }),
}))

import { prismaMock } from '@tests/__helpers__/setup'
import { createCheckoutSession } from '@/services/dashboard/paymentLink.service'
import { ConflictError } from '@/errors/AppError'

const CARD = { pan: '4111111111111111', cvv: '123', expMonth: '12', expYear: '2030', holderName: 'Ana' }

function link(over: Record<string, unknown> = {}) {
  return {
    id: 'pl-1',
    shortCode: 'abc',
    status: 'ACTIVE',
    expiresAt: null,
    isReusable: false,
    paymentCount: 0,
    purpose: 'PAYMENT',
    amountType: 'FIXED',
    amount: 100,
    currency: 'MXN',
    title: 'Clase',
    items: [],
    venueId: 'v1',
    ecommerceMerchant: { id: 'm-1', sandboxMode: true, providerCredentials: {}, provider: { code: 'BLUMON' } },
    ...over,
  } as any
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.paymentLink.findUnique.mockReset()
  prismaMock.checkoutSession.findFirst.mockReset()
  prismaMock.checkoutSession.create.mockReset().mockResolvedValue({ id: 's2', sessionId: 'cs_pl_x' } as any)
  mockTokenizeCard.mockReset().mockResolvedValue({ token: 'tok_x', maskedPan: '411111******1111', cardBrand: 'VISA' })
})

it('🔴 liga de un solo uso con un cobro en vuelo: 409 y no tokeniza ni abre otra sesión', async () => {
  prismaMock.paymentLink.findUnique.mockResolvedValue(link())
  prismaMock.checkoutSession.findFirst.mockResolvedValue({ id: 's1', sessionId: 'cs_pl_s1' } as any)

  const err = await createCheckoutSession('abc', CARD).catch(e => e)
  expect(err).toBeInstanceOf(ConflictError)
  expect(err.code).toBe('PAYMENT_IN_FLIGHT')
  // r6 #1: el identificador del cobro en vuelo es de OTRO pagador: se queda en el registro del servidor, nunca en la respuesta.
  expect(err.details).toBeUndefined()
  expect(prismaMock.checkoutSession.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({ where: { paymentLinkId: 'pl-1', status: 'CHARGING' } }),
  )
  expect(mockTokenizeCard).not.toHaveBeenCalled()
  expect(prismaMock.checkoutSession.create).not.toHaveBeenCalled()
})

it('regresión: una liga reutilizable no se bloquea por el cobro en vuelo de otra persona', async () => {
  prismaMock.paymentLink.findUnique.mockResolvedValue(link({ isReusable: true }))

  await createCheckoutSession('abc', CARD).catch(() => undefined)

  expect(prismaMock.checkoutSession.findFirst).not.toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ status: 'CHARGING' }) }),
  )
  expect(mockTokenizeCard).toHaveBeenCalled()
})

it('regresión: una liga de un solo uso sin cobro en vuelo sigue abriendo su sesión', async () => {
  prismaMock.paymentLink.findUnique.mockResolvedValue(link())
  prismaMock.checkoutSession.findFirst.mockResolvedValue(null)

  await createCheckoutSession('abc', CARD).catch(() => undefined)

  expect(mockTokenizeCard).toHaveBeenCalled()
})
