/**
 * R0 del rediseño de la compra (Codex, 21-sep-2026): el job de cancelación escribía por `id` LO QUE LEYÓ,
 * sin comprobar que la fila siguiera igual. Dos ventanas reales:
 *
 * - Rama de suspendidas: cancela `sub_vieja` en Stripe y luego limpia el vínculo por `id`. Si entre las dos
 *   se ligó una recompra (`sub_nueva`), borraba el vínculo NUEVO: la suscripción recién pagada quedaba sin
 *   representación local.
 * - Rama de trials locales: lee un trial vencido sin Stripe y lo desactiva por `id`. Si entre las dos una
 *   compra lo convirtió en pagado, le apagaba el acceso recién comprado (y le mandaba «tu prueba terminó»).
 */
const mockSubCancel = jest.fn()
jest.mock('stripe', () => jest.fn().mockImplementation(() => ({ subscriptions: { retrieve: jest.fn(), cancel: mockSubCancel } })))
jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))
const mockTrialEmail = jest.fn().mockResolvedValue(true)
const mockCanceledEmail = jest.fn().mockResolvedValue(true)
jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: {
    sendTrialExpiredEmail: (...a: unknown[]) => mockTrialEmail(...a),
    sendSubscriptionCanceledEmail: (...a: unknown[]) => mockCanceledEmail(...a),
  },
}))
jest.mock('@/observability/jobContext', () => ({ scheduleJob: jest.fn() }))
jest.mock('@/services/stripe.service', () => ({ __esModule: true, estadoDeLaSuscripcion: jest.fn().mockResolvedValue('unpaid') }))
jest.mock('@/services/access/planNotification.service', () => ({
  resolvePlanNotificationTarget: jest.fn().mockResolvedValue({ email: 'dueno@cafe.mx', locale: 'es' }),
}))

import prisma from '@/utils/prismaClient'
import { SubscriptionCancellationJob } from '@/jobs/subscription-cancellation.job'

const venue = { id: 'v1', name: 'Cafe', organization: { id: 'o1', email: 'o@b.c' } }
const suspendida = {
  id: 'vf1',
  venueId: 'v1',
  stripeSubscriptionId: 'sub_vieja',
  active: false,
  suspendedAt: new Date('2026-09-01T00:00:00Z'),
  gracePeriodEndsAt: new Date('2026-09-02T00:00:00Z'),
  feature: { id: 'f1', code: 'INVENTORY_TRACKING', name: 'Inventario' },
  venue,
}
const trialVencido = {
  id: 'vf2',
  venueId: 'v1',
  stripeSubscriptionId: null,
  active: true,
  endDate: new Date('2026-09-10T00:00:00Z'),
  feature: { id: 'f2', code: 'LOYALTY_PROGRAM', name: 'Lealtad' },
  venue,
}

const updateMany = () => prisma.venueFeature.updateMany as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  ;(prisma.venueFeature.findMany as jest.Mock).mockImplementation(async (args: any) =>
    args?.where?.suspendedAt ? [suspendida] : args?.where?.stripeSubscriptionId === null ? [trialVencido] : [],
  )
  ;(prisma.venueFeature.update as jest.Mock).mockResolvedValue({})
  updateMany().mockResolvedValue({ count: 1 })
})

describe('R0 · el job de cancelación escribe sólo si la fila sigue siendo la que procesó', () => {
  it('🔴 tras cancelar, limpia el vínculo SÓLO si sigue apuntando a la suscripción cancelada', async () => {
    await new SubscriptionCancellationJob().runNow()

    expect(mockSubCancel).toHaveBeenCalledWith('sub_vieja', expect.anything())
    expect(updateMany()).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'vf1', stripeSubscriptionId: 'sub_vieja' }),
        data: expect.objectContaining({ stripeSubscriptionId: null }),
      }),
    )
    // Nunca por id a secas: ése es el que borraba el vínculo nuevo.
    expect(prisma.venueFeature.update).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'vf1' } }))
  })

  it('🔴 un trial vencido se apaga SÓLO si sigue siendo trial local vencido', async () => {
    await new SubscriptionCancellationJob().runNow()

    expect(updateMany()).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'vf2', stripeSubscriptionId: null, active: true, endDate: expect.anything() }),
        data: { active: false },
      }),
    )
  })

  it('🔴 si mientras tanto se compró (el CAS no encontró la fila), NO avisa «tu prueba terminó»', async () => {
    updateMany().mockResolvedValue({ count: 0 })

    await new SubscriptionCancellationJob().runNow()

    expect(mockTrialEmail).not.toHaveBeenCalled()
  })

  it('🔴 si el vínculo cambió (recompra), NO avisa «tu suscripción se canceló» al negocio que acaba de pagar', async () => {
    ;(prisma.venueFeature.findMany as jest.Mock).mockImplementation(async (args: any) => (args?.where?.suspendedAt ? [suspendida] : []))
    updateMany().mockResolvedValue({ count: 0 })

    await new SubscriptionCancellationJob().runNow()

    expect(mockSubCancel).toHaveBeenCalledWith('sub_vieja', expect.anything())
    expect(mockCanceledEmail).not.toHaveBeenCalled()
  })
})
