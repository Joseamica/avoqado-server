/**
 * 🔴 Auditoría 2026-09-30: cancelar leía el estado y escribía después, sin candado. Si entre las dos cosas
 * el cobro reclamaba la sesión (CHARGING), la cancelación la pisaba.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { cancelCheckoutSession } from '@/services/sdk/checkout-session.service'

beforeEach(() => {
  prismaMock.checkoutSession.findUnique.mockReset()
  prismaMock.checkoutSession.findUniqueOrThrow.mockReset()
  prismaMock.checkoutSession.update.mockReset()
  prismaMock.checkoutSession.updateMany.mockReset()
})

it('🔴 si entre leer y escribir la sesión pasó a CHARGING, no la cancela', async () => {
  prismaMock.checkoutSession.findUnique.mockResolvedValue({ sessionId: 'cs_1', ecommerceMerchantId: 'm-1', status: 'PROCESSING' } as any)
  prismaMock.checkoutSession.updateMany.mockResolvedValue({ count: 0 } as any)

  await expect(cancelCheckoutSession('cs_1', 'm-1')).rejects.toThrow()
  expect(prismaMock.checkoutSession.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: { sessionId: 'cs_1', status: { in: ['PENDING', 'PROCESSING'] } } }),
  )
  expect(prismaMock.checkoutSession.update).not.toHaveBeenCalled()
})

it('regresión: una sesión PENDING se cancela y se devuelve cancelada', async () => {
  prismaMock.checkoutSession.findUnique.mockResolvedValueOnce({ sessionId: 'cs_1', ecommerceMerchantId: 'm-1', status: 'PENDING' } as any)
  prismaMock.checkoutSession.findUniqueOrThrow.mockResolvedValueOnce({
    sessionId: 'cs_1',
    ecommerceMerchantId: 'm-1',
    status: 'CANCELLED',
  } as any)
  prismaMock.checkoutSession.updateMany.mockResolvedValue({ count: 1 } as any)

  const result = await cancelCheckoutSession('cs_1', 'm-1')

  expect(result).toEqual(expect.objectContaining({ status: 'CANCELLED' }))
})
