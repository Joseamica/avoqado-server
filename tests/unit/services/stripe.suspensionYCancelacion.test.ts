/**
 * 🔴 SEXTA AUDITORÍA (Codex xhigh, 19-sep): los DOS caminos que quitan acceso tenían el mismo
 * defecto que el que lo devolvía, y uno de ellos llega a cancelar la suscripción.
 *
 * 1. **El espejo.** `handlePaymentFailure` suspende en el intento 4 SIN mirar si el cliente ya se
 *    puso al corriente. Secuencia reproducida por el auditor: el cliente se recupera, llega un
 *    aviso de fallo atrasado, y lo vuelve a suspender aunque Stripe diga `active`.
 *
 * 2. 🔴 **El peor escenario, y lo ABRIÓ el arreglo de la recuperación.** Ahora recuperar depende de
 *    consultar a Stripe. Si esa consulta falla hasta agotar los reintentos, el registro se queda
 *    `active:false` con `suspendedAt` puesto… y a los 14 días el cron de cancelación lo toma y
 *    **cancela la suscripción en Stripe**, sin comprobar si el cliente está al corriente. Antes ese
 *    webhook escribía `active:true` y el registro quedaba FUERA de ese cron.
 *
 * La regla, idéntica en los dos sentidos: **quitar acceso también se decide con el estado vigente.**
 */
const mockSubRetrieve = jest.fn()
const mockSubCancel = jest.fn()

jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    subscriptions: { retrieve: mockSubRetrieve, cancel: mockSubCancel },
    prices: { retrieve: jest.fn() },
    invoices: { createPreview: jest.fn() },
  })),
)
jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))
jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendPaymentFailedEmail: jest.fn() } }))
jest.mock('@/services/access/planNotification.service', () => ({ resolvePlanNotificationTarget: jest.fn().mockResolvedValue({ email: 'a@b.c' }) }))

import prisma from '@/utils/prismaClient'
import { handlePaymentFailure } from '@/services/stripe.service'

const planVivo = {
  id: 'vf1',
  venueId: 'v1',
  featureId: 'f1',
  active: true,
  suspendedAt: null,
  stripeSubscriptionId: 'sub_1',
  feature: { id: 'f1', code: 'PLAN_PRO', name: 'Plan Pro' },
  venue: { id: 'v1', name: 'Testarudo', email: 'v@b.c', organization: { email: 'o@b.c' } },
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue(planVivo)
  ;(prisma.venueFeature.update as jest.Mock).mockResolvedValue({})
})

describe('suspender también se decide con el estado VIGENTE', () => {
  it('🔴 un aviso de fallo ATRASADO no suspende si Stripe dice que está al corriente', async () => {
    mockSubRetrieve.mockResolvedValue({ id: 'sub_1', status: 'active' })

    await handlePaymentFailure('sub_1', 4)

    const suspendio = (prisma.venueFeature.update as jest.Mock).mock.calls.some(
      c => c[0]?.data?.suspendedAt != null || c[0]?.data?.active === false,
    )
    expect(suspendio).toBe(false)
  })

  it('un impago REAL sí suspende (no se rompió el caso bueno)', async () => {
    mockSubRetrieve.mockResolvedValue({ id: 'sub_1', status: 'past_due' })

    await handlePaymentFailure('sub_1', 4)

    const suspendio = (prisma.venueFeature.update as jest.Mock).mock.calls.some(c => c[0]?.data?.active === false)
    expect(suspendio).toBe(true)
  })

  it('🔴 si no se puede preguntar a Stripe, NO se suspende a ciegas', async () => {
    mockSubRetrieve.mockRejectedValue(new Error('Stripe caído'))

    await expect(handlePaymentFailure('sub_1', 4)).rejects.toThrow()

    const suspendio = (prisma.venueFeature.update as jest.Mock).mock.calls.some(c => c[0]?.data?.active === false)
    expect(suspendio).toBe(false)
  })
})
