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
jest.mock('@/services/access/planNotification.service', () => ({
  resolvePlanNotificationTarget: jest.fn().mockResolvedValue({ email: 'a@b.c' }),
}))

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
  ;(prisma.venueFeature.updateMany as jest.Mock)?.mockResolvedValue?.({ count: 1 })
  ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue(planVivo)
  ;(prisma.venueFeature.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
})

describe('suspender también se decide con el estado VIGENTE', () => {
  it('🔴 un aviso de fallo ATRASADO no suspende si Stripe dice que está al corriente', async () => {
    mockSubRetrieve.mockResolvedValue({ id: 'sub_1', status: 'active' })

    await handlePaymentFailure('sub_1', 4)

    const suspendio = (prisma.venueFeature.updateMany as jest.Mock).mock.calls.some(
      c => c[0]?.data?.suspendedAt != null || c[0]?.data?.active === false,
    )
    expect(suspendio).toBe(false)
  })

  it('un impago REAL sí suspende (no se rompió el caso bueno)', async () => {
    mockSubRetrieve.mockResolvedValue({ id: 'sub_1', status: 'past_due' })

    await handlePaymentFailure('sub_1', 4)

    const suspendio = (prisma.venueFeature.updateMany as jest.Mock).mock.calls.some(c => c[0]?.data?.active === false)
    expect(suspendio).toBe(true)
  })

  it('🔴 si no se puede preguntar a Stripe, NO se suspende a ciegas', async () => {
    mockSubRetrieve.mockRejectedValue(new Error('Stripe caído'))

    await expect(handlePaymentFailure('sub_1', 4)).rejects.toThrow()

    const suspendio = (prisma.venueFeature.updateMany as jest.Mock).mock.calls.some(c => c[0]?.data?.active === false)
    expect(suspendio).toBe(false)
  })
})

/**
 * 🔴 REGRESIÓN QUE INTRODUJO MI PROPIO ARREGLO (Codex, 19-sep).
 *
 * El flujo de cobranza escribe DOS veces: el seguimiento de fallos y, en el intento 4, la
 * suspensión. Al ponerles CAS, las dos usaban la marca leída al principio — pero la PRIMERA ya la
 * había movido, así que el CAS de la segunda fallaba SIEMPRE y el moroso conservaba el acceso.
 * También al reintentar. Ahora la primera escritura devuelve la marca nueva y la segunda la usa.
 *
 * El mock que devolvía `{}` (sin `count`) escondía esto: un `count` indefinido nunca es `0`.
 */
describe('🔴 la suspensión del intento 4 ocurre de verdad (dos escrituras, marcas encadenadas)', () => {
  it('suspende aunque el flujo haya escrito antes en la misma fila', async () => {
    const { handlePaymentFailure } = await import('@/services/stripe.service')
    // `clearAllMocks` no resetea implementaciones: sin esto hereda el «Stripe caído» de la
    // prueba anterior. Un impago REAL: la suscripción no está al corriente.
    mockSubRetrieve.mockResolvedValue({ id: 'sub_1', status: 'unpaid' })

    // Simula la fila real: cada escritura mueve la marca, y el CAS sólo acepta la vigente.
    let marca = new Date('2026-09-19T10:00:00.000Z')
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue({ ...planVivo, updatedAt: marca })
    ;(prisma.venueFeature.findUnique as jest.Mock).mockImplementation(async () => ({ updatedAt: marca }))
    ;(prisma.venueFeature.updateMany as jest.Mock).mockImplementation(async ({ where }: any) => {
      if (where.updatedAt && where.updatedAt.getTime() !== marca.getTime()) return { count: 0 }
      marca = new Date(marca.getTime() + 1000)
      return { count: 1 }
    })

    await handlePaymentFailure('sub_1', 4)

    const suspendio = (prisma.venueFeature.updateMany as jest.Mock).mock.calls.some(c => c[0]?.data?.active === false)
    expect(suspendio).toBe(true)
  })
})
