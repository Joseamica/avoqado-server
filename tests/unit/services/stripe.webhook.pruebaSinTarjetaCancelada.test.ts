/**
 * Planes editables B2, Task 6 (§16, §18): caracterización — debe pasar YA, sin código nuevo (Ruling P9).
 *
 * La prueba sin tarjeta se abre con `trial_settings.end_behavior.missing_payment_method: 'cancel'`: si al terminar sigue sin
 * tarjeta, Stripe la CANCELA y manda `customer.subscription.deleted`. El acceso sigue a la suscripción por el camino de hoy:
 * `handleSubscriptionDeleted` apaga su `VenueFeature` y ajusta el personal al tope de Gratis. Ningún reloj local vence esta
 * prueba y nada nuevo corre aquí. Si esta prueba falla, el camino de hoy cambió y la prueba sin tarjeta ya no termina en Gratis.
 *
 * La entrada real: `handleStripeWebhookEvent` con el evento tal como lo manda Stripe.
 */
import Stripe from 'stripe'

jest.mock('@/services/dashboard/seatReconciliation.service', () => ({
  __esModule: true,
  executeSeatReconciliation: jest.fn().mockResolvedValue(2),
  reactivateSeatCapDeactivated: jest.fn().mockResolvedValue(0),
}))
jest.mock('@/services/stripe.service', () => ({
  __esModule: true,
  default: jest.fn(),
  estadoDeLaSuscripcion: jest.fn(),
  suscripcionVendeElPlan: jest.fn().mockResolvedValue(true),
  entregarSuscripcionDePlan: jest.fn().mockResolvedValue(null),
  suscripcionVigente: jest.fn(),
  handlePaymentFailure: jest.fn(),
  generateBillingPortalUrl: jest.fn(),
  fulfillPlanCheckout: jest.fn(),
}))
jest.mock('@/services/dashboard/creditPack.public.service', () => ({ __esModule: true, fulfillPurchase: jest.fn() }))
jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendTrialEndingEmail: jest.fn() } }))
jest.mock('@/services/access/planNotification.service', () => ({ __esModule: true, resolvePlanNotificationTarget: jest.fn() }))
jest.mock('@/services/dashboard/notification.dashboard.service', () => ({ createNotification: jest.fn() }))
jest.mock('@/services/dashboard/token-budget.service', () => ({ tokenBudgetService: {} }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getServer: () => null, broadcastToVenue: jest.fn() } }))
jest.mock('@/services/launchCampaigns/hybridLifecycle.service', () => ({ handleHybridStripeEvent: jest.fn().mockResolvedValue(false) }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venueFeature: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    venue: { findUnique: jest.fn(), update: jest.fn() },
    webhookEvent: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
    hybridBillingOperation: { findFirst: jest.fn().mockResolvedValue(null) },
  },
}))
jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))

import prisma from '@/utils/prismaClient'
import { executeSeatReconciliation } from '@/services/dashboard/seatReconciliation.service'
import { createNotification } from '@/services/dashboard/notification.dashboard.service'
import emailService from '@/services/email.service'
import { handleStripeWebhookEvent } from '@/services/stripe.webhook.service'

const FIN = Math.floor(new Date('2026-12-09T16:00:00Z').getTime() / 1000)

/** La prueba sin tarjeta que Stripe canceló al terminar (missing_payment_method: 'cancel'). */
const pruebaCancelada = {
  id: 'sub_prueba',
  object: 'subscription',
  status: 'canceled',
  customer: 'cus_1',
  default_payment_method: null,
  trial_end: FIN,
  ended_at: FIN,
  canceled_at: FIN,
  cancel_at: null,
  cancel_at_period_end: false,
  trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
  cancellation_details: { reason: 'cancellation_requested' },
  metadata: { venueId: 'venue-1', featureCode: 'PLAN_PRO', sinTarjeta: 'true', planOfferVersion: '2' },
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(prisma.webhookEvent.create as jest.Mock).mockResolvedValue({ id: 'we_1' })
  ;(prisma.webhookEvent.update as jest.Mock).mockResolvedValue({})
  ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ id: 'venue-1' })
  ;(prisma.venueFeature.findMany as jest.Mock).mockResolvedValue([{ venueId: 'venue-1', feature: { code: 'PLAN_PRO' } }])
  ;(prisma.venueFeature.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
})

describe('customer.subscription.deleted de una prueba sin tarjeta', () => {
  it('Stripe cancela la prueba sin tarjeta al terminar: customer.subscription.deleted de hoy apaga su VenueFeature y ajusta el personal al tope de Gratis, sin nada nuevo', async () => {
    await handleStripeWebhookEvent({
      id: 'evt_prueba_terminada',
      object: 'event',
      type: 'customer.subscription.deleted',
      data: { object: pruebaCancelada },
    } as unknown as Stripe.Event)

    // El acceso se apaga por su suscripción, como cualquier plan que termina…
    expect(prisma.venueFeature.updateMany).toHaveBeenCalledWith({ where: { stripeSubscriptionId: 'sub_prueba' }, data: { active: false } })
    // …y el personal vuelve al tope de Gratis.
    expect(executeSeatReconciliation).toHaveBeenCalledWith('venue-1')
    // Nada nuevo: sin correo ni aviso propios de la prueba sin tarjeta (el «terminó» es de B3), y el evento queda bien procesado.
    expect(emailService.sendTrialEndingEmail).not.toHaveBeenCalled()
    expect(createNotification).not.toHaveBeenCalled()
    expect(prisma.webhookEvent.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { id: 'we_1' }, data: expect.objectContaining({ status: 'SUCCESS' }) }),
    )
  })
})
