/**
 * 🔴 V5-A paso 6 (Codex, pasos 2-5, P1-3): los manejadores viejos no pueden deshacer lo que decide la entrega.
 *
 * Escenario: una suscripción ligada a PREMIUM ahora vende PRO, pero PRO lo ocupa otra obligación viva. La entrega retira
 * PREMIUM y conserva el vínculo. Después, `subscription.updated` (también desde el barrido) y `invoice.payment_succeeded`
 * encontraban la fila POR EL VÍNCULO, veían `active` y REACTIVABAN PREMIUM: el negocio quedaba con un plan que ninguna
 * suscripción respalda.
 *
 * Regla: una fila de PLAN sólo la escribe el camino de siempre si su suscripción vende HOY ese mismo plan. Si vende otro,
 * o no se reconoce, decide la entrega (`entregarSuscripcionDePlan`), que ve las dos filas bajo el candado del negocio.
 */
jest.mock('@/services/dashboard/creditPack.public.service', () => ({ __esModule: true, fulfillPurchase: jest.fn() }))
jest.mock('@/services/stripe.service', () => ({
  __esModule: true,
  default: jest.fn(),
  getOrCreateStripeCustomer: jest.fn(),
  createTrialSubscriptions: jest.fn(),
  cancelSubscription: jest.fn(),
  updatePaymentMethod: jest.fn(),
  createTrialSetupIntent: jest.fn(),
  convertTrialToPaid: jest.fn(),
  getCustomerInvoices: jest.fn(),
  getInvoicePdfUrl: jest.fn(),
  syncFeaturesToStripe: jest.fn(),
  createCustomerPortalSession: jest.fn(),
  handlePaymentFailure: jest.fn(),
  generateBillingPortalUrl: jest.fn(),
  asegurarAccesoDelPlan: jest.fn(),
  estadoDeLaSuscripcion: jest.fn(),
  suscripcionVigente: jest.fn(),
  suscripcionVendeElPlan: jest.fn(),
  entregarSuscripcionDePlan: jest.fn(),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    webhookEvent: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    venueFeature: { findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    staffVenue: { findMany: jest.fn() },
    venue: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    billingObligationConflict: { findUnique: jest.fn() },
  },
}))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getServer: jest.fn(() => ({})), broadcastToVenue: jest.fn() },
}))
jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))
jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendTrialEndingEmail: jest.fn() } }))
jest.mock('@/services/dashboard/notification.dashboard.service', () => ({ createNotification: jest.fn() }))
jest.mock('@/services/dashboard/seatReconciliation.service', () => ({
  executeSeatReconciliation: jest.fn().mockResolvedValue(0),
  reactivateSeatCapDeactivated: jest.fn().mockResolvedValue(0),
}))

import Stripe from 'stripe'
import prisma from '@/utils/prismaClient'
import socketManager from '@/communication/sockets'
import { entregarSuscripcionDePlan, estadoDeLaSuscripcion, suscripcionVendeElPlan, suscripcionVigente } from '@/services/stripe.service'
import { handleInvoicePaymentSucceeded, handleSubscriptionUpdated } from '@/services/stripe.webhook.service'
import { reactivateSeatCapDeactivated } from '@/services/dashboard/seatReconciliation.service'

const LEIDA = new Date('2026-09-22T10:00:00.000Z')
const ITEMS = [{ priceId: 'price_pro', productId: 'prod_x', lookupKey: 'plan_pro_monthly' }]
const VIGENTE = { status: 'active', trialEnd: null, items: ITEMS, itemsCompletos: true }

const fila = (over: Record<string, unknown> = {}) => ({
  id: 'vf-premium',
  updatedAt: LEIDA,
  venueId: 'v1',
  featureId: 'feat_premium',
  active: false,
  suspendedAt: null,
  paymentFailureCount: 0,
  gracePeriodEndsAt: null,
  stripeSubscriptionId: 'sub_s',
  feature: { id: 'feat_premium', code: 'PLAN_PREMIUM', name: 'Plan Premium' },
  venue: { id: 'v1', name: 'Test Venue', status: 'ACTIVE' },
  ...over,
})

const aviso = { id: 'sub_s', status: 'active', trial_end: null } as unknown as Stripe.Subscription
const factura = { id: 'in_1', subscription: 'sub_s', amount_paid: 115884, currency: 'mxn', customer: 'cus_1' } as unknown as Stripe.Invoice

beforeEach(() => {
  jest.clearAllMocks()
  ;(prisma.venueFeature.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
  ;(suscripcionVigente as jest.Mock).mockResolvedValue(VIGENTE)
  ;(estadoDeLaSuscripcion as jest.Mock).mockResolvedValue('active')
  // La suscripción vende PRO: sólo coincide con una fila PLAN_PRO.
  ;(suscripcionVendeElPlan as jest.Mock).mockImplementation(async (_v: unknown, code: string) => code === 'PLAN_PRO')
  ;(entregarSuscripcionDePlan as jest.Mock).mockResolvedValue(null)
})

describe('customer.subscription.updated sobre una fila de PLAN', () => {
  it('🔴 la suscripción ya vende OTRO plan: decide la entrega y la fila vieja NO se reactiva', async () => {
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue(fila())

    await expect(handleSubscriptionUpdated(aviso)).resolves.toBe(false)

    expect(suscripcionVendeElPlan).toHaveBeenCalledWith(VIGENTE, 'PLAN_PREMIUM')
    expect(entregarSuscripcionDePlan).toHaveBeenCalledWith({
      venueId: 'v1',
      subscriptionId: 'sub_s',
      detectedBy: 'customer.subscription.updated',
    })
    expect(prisma.venueFeature.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 si no se reconoce qué vende, también decide la entrega (nunca se concede lo que no se entiende)', async () => {
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue(fila())
    ;(suscripcionVendeElPlan as jest.Mock).mockResolvedValue(false)

    await handleSubscriptionUpdated(aviso)

    expect(entregarSuscripcionDePlan).toHaveBeenCalled()
    expect(prisma.venueFeature.updateMany).not.toHaveBeenCalled()
  })

  it('si la entrega SÍ concede, avisa por socket y devuelve los asientos, igual que el checkout', async () => {
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue(fila())
    ;(entregarSuscripcionDePlan as jest.Mock).mockResolvedValue({
      venueId: 'v1',
      featureId: 'feat_pro',
      featureCode: 'PLAN_PRO',
      subscriptionId: 'sub_s',
      endDate: null,
    })

    await expect(handleSubscriptionUpdated(aviso)).resolves.toBe(true)

    expect(socketManager.broadcastToVenue).toHaveBeenCalledWith(
      'v1',
      'subscription.activated',
      expect.objectContaining({ featureCode: 'PLAN_PRO' }),
    )
    expect(reactivateSeatCapDeactivated).toHaveBeenCalledWith('v1')
  })

  it('🔴 Codex C11: sin fila ligada pero con un CONFLICTO pendiente (operaciones la corrigió en Stripe): decide la entrega', async () => {
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue(null)
    ;(prisma.billingObligationConflict.findUnique as jest.Mock).mockResolvedValue({ venueId: 'v1', status: 'PENDING' })
    ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ status: 'ACTIVE' })
    ;(entregarSuscripcionDePlan as jest.Mock).mockResolvedValue({
      venueId: 'v1',
      featureId: 'feat_pro',
      featureCode: 'PLAN_PRO',
      subscriptionId: 'sub_s',
      endDate: null,
    })

    await expect(handleSubscriptionUpdated(aviso)).resolves.toBe(true)

    expect(entregarSuscripcionDePlan).toHaveBeenCalledWith({
      venueId: 'v1',
      subscriptionId: 'sub_s',
      detectedBy: 'customer.subscription.updated',
    })
  })

  it('🔴 Codex R6: con conflicto pendiente pero el negocio NO operativo (suspendido por Avoqado): no se entrega', async () => {
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue(null)
    ;(prisma.billingObligationConflict.findUnique as jest.Mock).mockResolvedValue({ venueId: 'v1', status: 'PENDING' })
    ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ status: 'ADMIN_SUSPENDED' })

    await expect(handleSubscriptionUpdated(aviso)).resolves.toBe(false)

    expect(entregarSuscripcionDePlan).not.toHaveBeenCalled()
  })

  it.each([
    ['no hay conflicto', null],
    ['el conflicto ya se resolvió', { venueId: 'v1', status: 'RESOLVED' }],
  ])('sin fila ligada y %s: nada que hacer (una suscripción ajena no se entrega)', async (_n, conflicto) => {
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue(null)
    ;(prisma.billingObligationConflict.findUnique as jest.Mock).mockResolvedValue(conflicto)

    await expect(handleSubscriptionUpdated(aviso)).resolves.toBe(false)

    expect(entregarSuscripcionDePlan).not.toHaveBeenCalled()
  })

  it('vende el MISMO plan de la fila: el camino de siempre (sin la entrega)', async () => {
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue(fila({ feature: { id: 'feat_pro', code: 'PLAN_PRO', name: 'Pro' } }))

    await expect(handleSubscriptionUpdated(aviso)).resolves.toBe(true)

    expect(entregarSuscripcionDePlan).not.toHaveBeenCalled()
    expect((prisma.venueFeature.updateMany as jest.Mock).mock.calls[0][0].data).toMatchObject({ active: true })
  })

  it('una función SUELTA no pasa por esta regla', async () => {
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue(
      fila({ feature: { id: 'feat_inv', code: 'INVENTORY_TRACKING', name: 'Inventario' } }),
    )

    await handleSubscriptionUpdated(aviso)

    expect(suscripcionVendeElPlan).not.toHaveBeenCalled()
    expect(entregarSuscripcionDePlan).not.toHaveBeenCalled()
  })

  it('un estado que NO habilita (cancelada) desactiva como siempre, sin consultar qué vende', async () => {
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue(fila({ active: true }))
    ;(suscripcionVigente as jest.Mock).mockResolvedValue({ ...VIGENTE, status: 'canceled' })

    await expect(handleSubscriptionUpdated({ ...aviso, status: 'canceled' } as Stripe.Subscription)).resolves.toBe(false)

    expect(entregarSuscripcionDePlan).not.toHaveBeenCalled()
    expect((prisma.venueFeature.updateMany as jest.Mock).mock.calls[0][0].data).toEqual({ active: false })
  })
})

describe('invoice.payment_succeeded sobre una fila de PLAN', () => {
  it('🔴 la suscripción ya vende OTRO plan: decide la entrega y la fila vieja NO se reactiva', async () => {
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue(fila())

    await handleInvoicePaymentSucceeded(factura)

    expect(entregarSuscripcionDePlan).toHaveBeenCalledWith({
      venueId: 'v1',
      subscriptionId: 'sub_s',
      detectedBy: 'invoice.payment_succeeded',
    })
    expect(prisma.venueFeature.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 consulta Stripe UNA sola vez: el tier y el veredicto salen de la misma foto', async () => {
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue(fila({ feature: { id: 'feat_pro', code: 'PLAN_PRO', name: 'Pro' } }))

    await handleInvoicePaymentSucceeded(factura)

    expect(suscripcionVigente).toHaveBeenCalledTimes(1)
    expect(estadoDeLaSuscripcion).not.toHaveBeenCalled()
    expect((prisma.venueFeature.updateMany as jest.Mock).mock.calls[0][0].data).toMatchObject({ active: true, suspendedAt: null })
  })

  it('🔴 Codex C14: en `trialing` escribe el vencimiento VIGENTE de Stripe, no conserva el local (viejo o vacío)', async () => {
    const fin = new Date('2026-10-30T00:00:00.000Z')
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue(
      fila({ feature: { id: 'feat_pro', code: 'PLAN_PRO', name: 'Pro' }, endDate: new Date('2026-09-01T00:00:00.000Z') }),
    )
    ;(suscripcionVigente as jest.Mock).mockResolvedValue({ ...VIGENTE, status: 'trialing', trialEnd: fin })

    await handleInvoicePaymentSucceeded(factura)

    expect((prisma.venueFeature.updateMany as jest.Mock).mock.calls[0][0].data).toMatchObject({ active: true, endDate: fin })
  })

  it('una fila de plan ya ACTIVA y sana no consulta nada (como siempre)', async () => {
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue(fila({ active: true }))

    await handleInvoicePaymentSucceeded(factura)

    expect(suscripcionVigente).not.toHaveBeenCalled()
    expect(entregarSuscripcionDePlan).not.toHaveBeenCalled()
    expect(prisma.venueFeature.updateMany).not.toHaveBeenCalled()
  })
})
