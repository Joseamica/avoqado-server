/**
 * 🔴 SEXTA AUDITORÍA (Codex xhigh, 19-sep): el PEOR escenario del sistema, y lo abrió el arreglo
 * de la recuperación.
 *
 * Este cron cancela en Stripe las suscripciones que llevan 14+ días suspendidas. Decidía sólo con
 * NUESTRO registro (`active:false` + `suspendedAt` + gracia vencida), y ese registro puede mentir:
 * si el webhook de recuperación no pudo consultar a Stripe y agotó sus reintentos, el negocio se
 * queda `active:false` aunque esté pagando. A los 14 días este cron le cancela la suscripción.
 *
 * Antes del arreglo de la recuperación, ese webhook escribía `active:true` y el registro quedaba
 * FUERA de esta consulta. O sea: arreglar un lado abrió este camino. Por eso la comprobación aquí
 * no es defensa en profundidad, es parte del mismo arreglo.
 *
 * Un acceso denegado se repara; una suscripción cancelada obliga al cliente a volver a contratar.
 */
const mockSubRetrieve = jest.fn()
const mockSubCancel = jest.fn()

jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    subscriptions: { retrieve: mockSubRetrieve, cancel: mockSubCancel },
  })),
)
jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))
jest.mock('@/services/email.service', () => ({ __esModule: true, default: {} }))
jest.mock('@/observability/jobContext', () => ({ scheduleJob: jest.fn() }))
jest.mock('@/services/stripe.service', () => ({
  __esModule: true,
  estadoDeLaSuscripcion: jest.fn(),
}))

import prisma from '@/utils/prismaClient'
import { estadoDeLaSuscripcion } from '@/services/stripe.service'
import { SubscriptionCancellationJob } from '@/jobs/subscription-cancellation.job'

const suspendidoHaceMucho = {
  id: 'vf1',
  venueId: 'v1',
  stripeSubscriptionId: 'sub_1',
  active: false,
  suspendedAt: new Date('2026-09-01T00:00:00Z'),
  gracePeriodEndsAt: new Date('2026-09-02T00:00:00Z'),
  feature: { id: 'f1', code: 'PLAN_PRO', name: 'Plan Pro' },
  venue: { id: 'v1', name: 'Testarudo', organization: { id: 'o1', email: 'o@b.c' } },
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(prisma.venueFeature.findMany as jest.Mock).mockImplementation(async (args: any) =>
    args?.where?.suspendedAt ? [suspendidoHaceMucho] : [],
  )
  ;(prisma.venueFeature.update as jest.Mock).mockResolvedValue({})
  ;(prisma.venueFeature.updateMany as jest.Mock)?.mockResolvedValue?.({ count: 0 })
})

describe('el cron NO cancela la suscripción de quien está pagando', () => {
  it('🔴 si Stripe dice `active`, NO cancela aunque nuestro registro diga suspendido', async () => {
    ;(estadoDeLaSuscripcion as jest.Mock).mockResolvedValue('active')

    await new SubscriptionCancellationJob().runNow()

    expect(mockSubCancel).not.toHaveBeenCalled()
  })

  it('🔴 tampoco con `trialing`', async () => {
    ;(estadoDeLaSuscripcion as jest.Mock).mockResolvedValue('trialing')

    await new SubscriptionCancellationJob().runNow()

    expect(mockSubCancel).not.toHaveBeenCalled()
  })

  it('un moroso REAL (`unpaid`) sí se cancela: el cron sigue haciendo su trabajo', async () => {
    ;(estadoDeLaSuscripcion as jest.Mock).mockResolvedValue('unpaid')

    await new SubscriptionCancellationJob().runNow()

    expect(mockSubCancel).toHaveBeenCalledWith('sub_1', expect.anything())
  })
})
