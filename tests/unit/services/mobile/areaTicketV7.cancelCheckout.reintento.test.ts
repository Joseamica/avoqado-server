/**
 * S5b (red por traba, R65 b): `cancelAreaTicketCheckout` tras un 40P01. La orden que se canceló en el intento ABORTADO se deshizo con él:
 * el aviso de «orden cancelada» sale sólo del intento que hizo commit.
 */
import { prismaMock } from '@tests/__helpers__/setup'

const mockAvisar = jest.fn()
jest.mock('@/services/shared/orderCancelGuard', () => ({
  ...jest.requireActual('@/services/shared/orderCancelGuard'),
  assertOrderCancellableUnderLock: jest.fn().mockResolvedValue(undefined),
  devolverCanjesDeVentaAnuladaEnTx: jest.fn().mockResolvedValue(undefined),
  avisarOrdenCancelada: (...a: unknown[]) => mockAvisar(...a),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import { cancelAreaTicketCheckout } from '@/services/mobile/areaTicketV7.mobile.service'

const sesion = (over: Record<string, unknown> = {}) => ({
  id: 'ses-1',
  venueId: 'v1',
  status: 'OPEN',
  terminalId: 'term-1',
  orderId: 'order-1',
  order: null,
  cancelIdempotencyKey: null,
  activePaymentAttemptId: null,
  version: 1,
  tickets: [],
  paymentAttempts: [],
  terminal: { id: 'term-1' },
  ...over,
})

describe('cancelAreaTicketCheckout — la red por traba (40P01)', () => {
  it('[repetirNoDuplica:cancelAreaTicketCheckout] el aviso de «orden cancelada» no sale si sólo el intento ABORTADO la canceló', async () => {
    ;(prismaMock as any).terminal.findFirst.mockResolvedValue({ id: 'term-1', canCheckoutAreaTickets: true })
    ;(prismaMock as any).areaTicketCheckoutSession.findFirst.mockResolvedValue(sesion())
    ;(prismaMock as any).staffVenue.findFirst.mockResolvedValue(null)
    prismaMock.$queryRaw.mockResolvedValue([] as any)
    // Intento 1: la orden se cancela (count 1). Intento 2: otro camino ya la había cancelado (count 0) y la sesión ya está CANCELLED.
    prismaMock.order.updateMany.mockResolvedValueOnce({ count: 1 } as any).mockResolvedValue({ count: 0 } as any)
    ;(prismaMock as any).areaTicketCheckoutSession.findUniqueOrThrow.mockResolvedValue(sesion({ status: 'CANCELLED' }))
    ;(prismaMock as any).areaTicket.updateMany.mockResolvedValue({ count: 0 })
    ;(prismaMock as any).areaTicketCheckoutSession.update.mockResolvedValue({})
    let llamada = 0
    prismaMock.$transaction.mockImplementation((async (cb: any) => {
      const r = await cb(prismaMock)
      if (++llamada === 1) {
        ;(prismaMock as any).areaTicketCheckoutSession.findFirst.mockResolvedValue(sesion({ status: 'CANCELLED' }))
        throw Object.assign(new Error('deadlock detected'), { code: '40P01' })
      }
      return r
    }) as any)

    try {
      await cancelAreaTicketCheckout('v1', 'ses-1', { idempotencyKey: 'k1', deviceUid: 'dev-1', staffId: null } as any)

      expect(llamada).toBe(2)
      expect(mockAvisar).not.toHaveBeenCalled()
    } finally {
      prismaMock.$transaction.mockImplementation(((cb: any) => cb(prismaMock)) as any)
    }
  })
})
