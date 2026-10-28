/**
 * H0 (28-oct-2026): la factura pagada del alta (la PRIMERA de la suscripción) programa el cierre del alta, ANTES de las
 * salidas tempranas del manejador (plan aún sin fila de acceso, o ya activo) — Codex r1 #3. Las renovaciones no.
 */
jest.mock('@/services/onboarding/altaPorAvisoDeStripe', () => ({ __esModule: true, programarCierreDelAltaPorAviso: jest.fn() }))
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
import { suscripcionVigente } from '@/services/stripe.service'
import { handleInvoicePaymentSucceeded } from '@/services/stripe.webhook.service'
import { programarCierreDelAltaPorAviso } from '@/services/onboarding/altaPorAvisoDeStripe'

const planActivo = {
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
const base = { id: 'in_1', amount_paid: 1000, amount_due: 1000, attempt_count: 1, currency: 'mxn', customer: 'cus_1' }
const vieja = (extra: Record<string, unknown>) => ({ ...base, subscription: 'sub_pro', ...extra }) as unknown as Stripe.Invoice
const basil = (extra: Record<string, unknown>) =>
  ({
    ...base,
    parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_pro', metadata: {} } },
    ...extra,
  }) as unknown as Stripe.Invoice

beforeEach(() => {
  jest.clearAllMocks()
  jest.useRealTimers()
  ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue(planActivo)
  ;(suscripcionVigente as jest.Mock).mockResolvedValue({ status: 'active', trialEnd: null })
})

describe('🔴 H0: la primera factura pagada programa el cierre del alta', () => {
  it.each([
    ['forma vieja (2020-03-02, prod)', vieja],
    ['forma basil', basil],
  ])('%s: la factura de alta (subscription_create) lo programa con su suscripción', async (_n, factura) => {
    await handleInvoicePaymentSucceeded(factura({ billing_reason: 'subscription_create' }))
    expect(programarCierreDelAltaPorAviso).toHaveBeenCalledWith('sub_pro')
  })

  it('también cuando el plan ya estaba activo (la salida temprana de «ya activo» no lo salta)', async () => {
    await handleInvoicePaymentSucceeded(vieja({ billing_reason: 'subscription_create' }))
    expect(programarCierreDelAltaPorAviso).toHaveBeenCalledTimes(1)
  })

  it('también cuando todavía no existe la fila de acceso del plan (el cobro del alta la crea después)', async () => {
    jest.useFakeTimers()
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue(null)
    const corrida = handleInvoicePaymentSucceeded(vieja({ billing_reason: 'subscription_create' }))
    await jest.advanceTimersByTimeAsync(2_000)
    await corrida
    expect(programarCierreDelAltaPorAviso).toHaveBeenCalledWith('sub_pro')
  })

  it.each(['subscription_cycle', 'subscription_update', 'manual'])('una factura %s (renovación u otra) no lo programa', async motivo => {
    await handleInvoicePaymentSucceeded(vieja({ billing_reason: motivo }))
    expect(programarCierreDelAltaPorAviso).not.toHaveBeenCalled()
  })
})
