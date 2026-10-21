/**
 * 🔴 LA FACTURA EN LA FORMA NUEVA DE STRIPE (basil, 2025-03-31) — 19-oct-2026.
 *
 * Desde la versión basil, el objeto Invoice ya NO trae `invoice.subscription`: el id vive en
 * `invoice.parent.subscription_details.subscription`. La forma del evento la decide la versión del
 * ENDPOINT del webhook, no el cliente del SDK.
 *
 * Medido el 19-oct en Stripe real: el endpoint de planes (`/api/v1/webhooks/stripe`) tiene
 * `api_version: null`, o sea que sigue la versión GENERAL de la cuenta (hoy 2020-03-02, que trae los
 * dos campos). Basta con que alguien presione «Upgrade API version» en el panel de Stripe para que
 * `invoice.subscription` desaparezca, y entonces los dos manejadores salían con «no subscription,
 * skipping»: un plan con pago fallido no se suspendía ni se avisaba, y Stripe recibía un 200.
 */
jest.mock('@/services/dashboard/creditPack.public.service', () => ({ __esModule: true, fulfillPurchase: jest.fn() }))
jest.mock('@/services/stripe.service', () => ({
  __esModule: true,
  default: jest.fn(),
  handlePaymentFailure: jest.fn(),
  generateBillingPortalUrl: jest.fn(),
  asegurarAccesoDelPlan: jest.fn(),
  estadoDeLaSuscripcion: jest.fn(),
  suscripcionVendeElPlan: jest.fn().mockResolvedValue(true),
  entregarSuscripcionDePlan: jest.fn().mockResolvedValue(null),
  suscripcionVigente: jest.fn(),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    webhookEvent: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    venueFeature: { findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    staffVenue: { findMany: jest.fn() },
    venue: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    hybridBillingOperation: { findFirst: jest.fn().mockResolvedValue(null) },
  },
}))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getServer: jest.fn(() => ({})), broadcastToVenue: jest.fn() },
}))
jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))
jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendTrialEndingEmail: jest.fn() } }))
jest.mock('@/services/dashboard/notification.dashboard.service', () => ({ createNotification: jest.fn() }))
jest.mock('@/services/launchCampaigns/hybridLifecycle.service', () => ({ handleHybridStripeEvent: jest.fn().mockResolvedValue(false) }))

import Stripe from 'stripe'
import prisma from '@/utils/prismaClient'
import { handlePaymentFailure, suscripcionVigente } from '@/services/stripe.service'
import { handleInvoicePaymentFailed, handleInvoicePaymentSucceeded, handleStripeWebhookEvent } from '@/services/stripe.webhook.service'

const plan = {
  id: 'vf1',
  updatedAt: new Date('2026-10-19T10:00:00.000Z'),
  venueId: 'v1',
  featureId: 'feat_pro',
  active: true,
  suspendedAt: null,
  paymentFailureCount: 0,
  stripeSubscriptionId: 'sub_pro',
  feature: { id: 'feat_pro', code: 'PLAN_PRO', name: 'Plan Pro' },
  venue: { id: 'v1', name: 'Test Venue', status: 'ACTIVE' },
}

const base = { id: 'in_1', amount_paid: 115884, amount_due: 115884, attempt_count: 1, currency: 'mxn', customer: 'cus_1' }

/** Forma basil o posterior: sin `subscription` arriba. */
const facturaBasil = {
  ...base,
  parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_pro', metadata: {} } },
} as unknown as Stripe.Invoice

/** Forma vieja (endpoint 2020-03-02, lo que llega hoy en producción). */
const facturaVieja = { ...base, subscription: 'sub_pro' } as unknown as Stripe.Invoice

beforeEach(() => {
  jest.clearAllMocks()
  ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue(plan)
  ;(prisma.venueFeature.update as jest.Mock).mockResolvedValue({})
  ;(prisma.venueFeature.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
  ;(prisma.staffVenue.findMany as jest.Mock).mockResolvedValue([])
  ;(suscripcionVigente as jest.Mock).mockResolvedValue({ status: 'active', trialEnd: null })
})

describe('invoice.payment_failed con la factura en forma basil', () => {
  it('🔴 encuentra la suscripción en `parent.subscription_details` y arranca la cobranza', async () => {
    await handleInvoicePaymentFailed(facturaBasil)

    expect(prisma.venueFeature.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { stripeSubscriptionId: 'sub_pro' } }))
    expect(handlePaymentFailure).toHaveBeenCalledWith('sub_pro', 1, expect.objectContaining({ invoiceId: 'in_1' }))
  })

  it('sigue funcionando con la forma vieja que llega hoy', async () => {
    await handleInvoicePaymentFailed(facturaVieja)

    expect(handlePaymentFailure).toHaveBeenCalledWith('sub_pro', 1, expect.objectContaining({ invoiceId: 'in_1' }))
  })

  it('una factura sin suscripción en ningún lugar se sigue saltando', async () => {
    await handleInvoicePaymentFailed({ ...base } as unknown as Stripe.Invoice)

    expect(prisma.venueFeature.findFirst).not.toHaveBeenCalled()
    expect(handlePaymentFailure).not.toHaveBeenCalled()
  })
})

describe('invoice.payment_succeeded con la factura en forma basil', () => {
  it('🔴 encuentra el plan por la suscripción de `parent.subscription_details`', async () => {
    await handleInvoicePaymentSucceeded(facturaBasil)

    expect(prisma.venueFeature.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { stripeSubscriptionId: 'sub_pro' } }))
  })

  it('sigue funcionando con la forma vieja que llega hoy', async () => {
    await handleInvoicePaymentSucceeded(facturaVieja)

    expect(prisma.venueFeature.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { stripeSubscriptionId: 'sub_pro' } }))
  })

  it('una factura sin suscripción en ningún lugar se sigue saltando', async () => {
    await handleInvoicePaymentSucceeded({ ...base } as unknown as Stripe.Invoice)

    expect(prisma.venueFeature.findFirst).not.toHaveBeenCalled()
  })
})

/**
 * Codex r1 (19-oct, AJENO P3): el enriquecimiento del evento también leía sólo `subscription`. Con la
 * forma basil, `WebhookEvent.venueId` quedaba vacío y el evento desaparecía del monitor por negocio.
 */
describe('el evento guardado queda ligado a su negocio con la factura basil', () => {
  it('🔴 estampa el venueId del plan encontrado por `parent.subscription_details`', async () => {
    ;(prisma.webhookEvent.create as jest.Mock).mockResolvedValue({ id: 'we1' })
    ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ id: 'v1' })

    await handleStripeWebhookEvent({
      id: 'evt_1',
      type: 'invoice.payment_failed',
      data: { object: facturaBasil },
    } as unknown as Stripe.Event)

    expect(prisma.webhookEvent.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'we1' }, data: { venueId: 'v1' } }))
  })
})
