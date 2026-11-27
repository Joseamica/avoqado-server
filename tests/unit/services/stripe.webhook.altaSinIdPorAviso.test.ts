/**
 * Planes editables B2, Task 5 (b2-r1 #1, revisión Important #1): el aviso de la PRIMERA factura pagada cierra el alta cuyo id
 * nunca se guardó, también con la forma que manda el endpoint de planes en producción (API 2020-03-02: sin `parent`, con la
 * metadata de la suscripción en `subscription_details.metadata`).
 *
 * El manejador real del aviso, el temporizador real del cierre (`altaPorAvisoDeStripe`) y el CAS real que registra el id
 * (`registrarSuscripcionDelIntento`). Se simulan la base, el cierre sin navegador (probado en su suite) y lo demás del
 * manejador, como en `stripe.webhook.altaPorAviso.test.ts`.
 */
jest.mock('@/services/onboarding/planActivation.service', () => ({ __esModule: true, cerrarAltaSinNavegador: jest.fn() }))
jest.mock('@/services/onboarding/terminarAltaCobrada', () => ({ __esModule: true, terminarAltaCobradaSinRomper: jest.fn() }))
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
    onboardingProgress: { findFirst: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
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
import { cerrarAltaSinNavegador } from '@/services/onboarding/planActivation.service'

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
const META = { organizationId: 'org-1', planActivationKey: 'plan-activation:org-1:3', planOfferVersion: '2' }
const base = {
  id: 'in_1',
  amount_paid: 92684,
  amount_due: 92684,
  attempt_count: 1,
  currency: 'mxn',
  customer: 'cus_1',
  billing_reason: 'subscription_create',
  subscription: 'sub_pro',
}
const progreso = prisma.onboardingProgress as unknown as Record<'findFirst' | 'findUnique' | 'updateMany', jest.Mock>

beforeEach(() => {
  jest.clearAllMocks()
  jest.useFakeTimers()
  ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue(planActivo)
  ;(suscripcionVigente as jest.Mock).mockResolvedValue({ status: 'active', trialEnd: null })
  ;(cerrarAltaSinNavegador as jest.Mock).mockResolvedValue('CERRADA')
  // Nadie apunta a esa suscripción: la respuesta del create se perdió antes de guardar su id. El alta sigue a medio pago en el
  // intento 3, sin id.
  progreso.findFirst.mockResolvedValue(null)
  progreso.findUnique.mockResolvedValue({
    completedAt: null,
    planActivationStatus: 'IN_PROGRESS',
    planActivationAttempt: 3,
    planStripeSubscriptionId: null,
  })
  progreso.updateMany.mockResolvedValue({ count: 1 })
})

afterEach(() => jest.useRealTimers())

describe('B2 Task 5: el aviso de Stripe cierra el alta cuyo id nunca se guardó', () => {
  it('🔴 forma 2020-03-02 (sin parent, la metadata en subscription_details.metadata): registra el id con su CAS y cierra el alta', async () => {
    await handleInvoicePaymentSucceeded({ ...base, subscription_details: { metadata: META } } as unknown as Stripe.Invoice)
    expect(cerrarAltaSinNavegador).not.toHaveBeenCalled()

    // El cierre espera 30 s (para no pelear con el navegador que vuelve del banco).
    await jest.advanceTimersByTimeAsync(30_000)

    expect(progreso.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', planActivationAttempt: 3, planActivationStatus: 'IN_PROGRESS', planStripeSubscriptionId: null },
      data: { planStripeSubscriptionId: 'sub_pro' },
    })
    expect(cerrarAltaSinNavegador).toHaveBeenCalledWith('org-1', 'aviso-stripe')
  })

  it('la forma basil (parent.subscription_details.metadata) hace lo mismo', async () => {
    await handleInvoicePaymentSucceeded({
      ...base,
      subscription: undefined,
      parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_pro', metadata: META } },
    } as unknown as Stripe.Invoice)
    await jest.advanceTimersByTimeAsync(30_000)

    expect(progreso.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { planStripeSubscriptionId: 'sub_pro' } }))
    expect(cerrarAltaSinNavegador).toHaveBeenCalledWith('org-1', 'aviso-stripe')
  })

  it('sin la metadata en ninguna de las dos formas: nada (lo de hoy), ni registro ni cierre', async () => {
    await handleInvoicePaymentSucceeded(base as unknown as Stripe.Invoice)
    await jest.advanceTimersByTimeAsync(30_000)

    expect(progreso.findFirst).toHaveBeenCalledWith({
      where: { planStripeSubscriptionId: 'sub_pro', completedAt: null },
      select: { organizationId: true, planActivationStatus: true },
    })
    expect(progreso.updateMany).not.toHaveBeenCalled()
    expect(cerrarAltaSinNavegador).not.toHaveBeenCalled()
  })
})
