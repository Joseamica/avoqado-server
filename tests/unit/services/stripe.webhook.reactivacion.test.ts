/**
 * 🔴 AUDITORÍA DE CODEX (2026-09-18, hallazgo #11): PAGA Y SIGUE SIN ACCESO.
 *
 * Cuando una suscripción se suspende por falta de pago se escribe `VenueFeature.suspendedAt`. El
 * resolver de acceso lo trata como candado duro:
 *
 *     basePlan.service.ts:91 → if (!vf.active || vf.suspendedAt) return false
 *
 * Al recuperarse el pago, `handleInvoicePaymentSucceeded` reactiva `active: true` … y **deja
 * `suspendedAt` puesto**. El negocio paga, Stripe cobra, el webhook dice «Feature activated after
 * successful payment» — y el producto le sigue negando el acceso, sin que nada lo denuncie.
 *
 * El propio comentario del handler dice que cubre «Reactivation after payment failure suspension».
 * No lo cubría.
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
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    webhookEvent: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    venueFeature: { findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    staffVenue: { findMany: jest.fn() },
    venue: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  },
}))
jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))
jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendTrialEndingEmail: jest.fn() } }))
jest.mock('@/services/dashboard/notification.dashboard.service', () => ({ createNotification: jest.fn() }))

import Stripe from 'stripe'
import prisma from '@/utils/prismaClient'
import { handleInvoicePaymentSucceeded } from '@/services/stripe.webhook.service'

/** Un plan SUSPENDIDO por falta de pago: `active:false` y `suspendedAt` con fecha. */
const planSuspendido = {
  id: 'vf1',
  venueId: 'v1',
  featureId: 'feat_pro',
  active: false,
  suspendedAt: new Date('2026-09-01T00:00:00Z'),
  paymentFailureCount: 3,
  gracePeriodEndsAt: new Date('2026-09-05T00:00:00Z'),
  stripeSubscriptionId: 'sub_pro',
  feature: { id: 'feat_pro', code: 'PLAN_PRO', name: 'Plan Pro' },
  venue: { id: 'v1', name: 'Test Venue', status: 'ACTIVE' },
}

const facturaPagada = {
  id: 'in_1',
  subscription: 'sub_pro',
  amount_paid: 115884,
  currency: 'mxn',
  customer: 'cus_1',
} as unknown as Stripe.Invoice

beforeEach(() => {
  jest.clearAllMocks()
  ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue(planSuspendido)
  ;(prisma.venueFeature.update as jest.Mock).mockResolvedValue({})
  // Por defecto Stripe dice que está al corriente: el caso normal es «pagó y se recupera».
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ;(require('@/services/stripe.service').estadoDeLaSuscripcion as jest.Mock).mockResolvedValue('active')
})

describe('recuperar el pago devuelve el ACCESO, no sólo el flag `active`', () => {
  it('🔴 limpia `suspendedAt`: si se queda puesto, el resolver sigue negando aunque ya pagó', async () => {
    await handleInvoicePaymentSucceeded(facturaPagada)

    const escritura = (prisma.venueFeature.update as jest.Mock).mock.calls[0]?.[0]
    expect(escritura?.data).toHaveProperty('suspendedAt', null)
  })

  it('🔴 y pone el contador de fallos en cero: si no, el siguiente tropiezo suspende de inmediato', async () => {
    await handleInvoicePaymentSucceeded(facturaPagada)

    const escritura = (prisma.venueFeature.update as jest.Mock).mock.calls[0]?.[0]
    expect(escritura?.data).toHaveProperty('paymentFailureCount', 0)
  })

  it('sigue reactivando el plan, que es lo que ya hacía bien', async () => {
    await handleInvoicePaymentSucceeded(facturaPagada)

    const escritura = (prisma.venueFeature.update as jest.Mock).mock.calls[0]?.[0]
    expect(escritura?.data).toMatchObject({ active: true })
  })
})

/**
 * 🔴 SEGUNDA AUDITORÍA DE CODEX (2026-09-18): el arreglo de arriba cubre UN camino de los dos.
 *
 * Cuando el pago se recupera, Stripe emite `invoice.payment_succeeded` **y**
 * `customer.subscription.updated` (status `active`). El primero ya limpia el candado; el segundo
 * escribe sólo `{ active: true, endDate: null }` y **deja `suspendedAt` puesto**.
 *
 * Basta con que el `invoice.payment_succeeded` no llegue —o llegue y falle su entrega— para que el
 * negocio quede otra vez pagando sin acceso. Y `status: 'active'` de Stripe ya afirma que el dinero
 * está al corriente: es autoridad suficiente para soltar el candado.
 */
describe('customer.subscription.updated con status ACTIVE también suelta el candado', () => {
  const suscripcionActiva = {
    id: 'sub_pro',
    status: 'active',
    trial_end: null,
    current_period_end: 1790000000,
  } as unknown as Stripe.Subscription

  it('🔴 limpia `suspendedAt`: recuperar el pago por este camino también devuelve el acceso', async () => {
    const { handleSubscriptionUpdated } = await import('@/services/stripe.webhook.service')
    await handleSubscriptionUpdated(suscripcionActiva)

    const escritura = (prisma.venueFeature.update as jest.Mock).mock.calls[0]?.[0]
    expect(escritura?.data).toHaveProperty('suspendedAt', null)
  })

  it('🔴 y pone el contador de fallos en cero, igual que el otro camino', async () => {
    const { handleSubscriptionUpdated } = await import('@/services/stripe.webhook.service')
    await handleSubscriptionUpdated(suscripcionActiva)

    const escritura = (prisma.venueFeature.update as jest.Mock).mock.calls[0]?.[0]
    expect(escritura?.data).toHaveProperty('paymentFailureCount', 0)
  })

  it('sigue activando el plan y borrando el fin de vigencia, que es lo que ya hacía bien', async () => {
    const { handleSubscriptionUpdated } = await import('@/services/stripe.webhook.service')
    await handleSubscriptionUpdated(suscripcionActiva)

    const escritura = (prisma.venueFeature.update as jest.Mock).mock.calls[0]?.[0]
    expect(escritura?.data).toMatchObject({ active: true, endDate: null })
  })
})

/**
 * 🔴 CUARTA AUDITORÍA (Codex, 19-sep): «necesita reactivación» NO es `!active`.
 *
 * Un registro `active: true` CON `suspendedAt` puesto está bloqueado igual (`basePlan:91`) y
 * ningún job lo rescata: winback y cancelación buscan `active: false`. Preguntar sólo por `active`
 * dejaba al negocio pagando sin acceso, para siempre.
 *
 * ⚠️ Aquí vivían además cuatro pruebas de la ARITMÉTICA DE FECHAS (evento anterior/posterior a la
 * suspensión, el mismo segundo). Se retiraron con ese enfoque: la quinta auditoría demostró que
 * comparar `event.created` contra `suspendedAt` es inválido de raíz, porque el segundo guarda la
 * hora en que NOSOTROS procesamos el fallo. Lo que las sustituye es el último describe.
 */
describe('un registro ACTIVO pero SUSPENDIDO sigue necesitando rescate', () => {
  const SUSPENDIDO_EL = new Date('2026-09-18T00:00:00Z')

  it('🔴 un pago bueno sobre un registro ACTIVO pero SUSPENDIDO sí lo rescata', async () => {
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue({
      ...planSuspendido,
      active: true,
      suspendedAt: SUSPENDIDO_EL,
    })

    await handleInvoicePaymentSucceeded({ ...facturaPagada } as never)

    const escritura = (prisma.venueFeature.update as jest.Mock).mock.calls[0]?.[0]
    expect(escritura?.data).toHaveProperty('suspendedAt', null)
  })

  it('🔴 y la aserción es ESTRICTA: la clave no puede llegar como `undefined`', async () => {
    await handleInvoicePaymentSucceeded({ ...facturaPagada } as never)

    const escritura = (prisma.venueFeature.update as jest.Mock).mock.calls[0]?.[0]
    // `not.toBeNull()` aceptaba `undefined` y no probaba nada. Esto sí. (Codex, 4ª auditoría.)
    expect(Object.keys(escritura?.data ?? {})).toContain('suspendedAt')
    expect(escritura?.data?.suspendedAt).toBeNull()
  })
})


/**
 * 🔴 QUINTA AUDITORÍA (Codex xhigh, 19-sep) — la RAÍZ de cinco rondas de parches.
 *
 * `handlePaymentFailure` guarda `suspendedAt = new Date()`: la hora en que NOSOTROS procesamos el
 * fallo, no la del evento en Stripe. Comparar contra `event.created` (hora de Stripe) es comparar
 * magnitudes distintas, y ninguna precisión lo arregla:
 *
 *     12:00:00  falla el cobro en Stripe
 *     12:00:01  el cliente PAGA
 *     12:00:03  procesamos el fallo  →  suspendedAt = 12:00:03
 *     → el pago de las 12:00:01 parece «anterior» y se descarta
 *     → paga y queda bloqueado
 *
 * El enfoque correcto no es ordenar eventos: es preguntar por el estado VIGENTE. Si Stripe dice
 * que la suscripción está al corriente AHORA, el negocio pagó, sin importar en qué orden llegaron
 * los avisos. Eso elimina toda la aritmética de fechas.
 */
describe('la suspensión la levanta el ESTADO VIGENTE, no el orden de los eventos', () => {
  const PROCESADO_TARDE = new Date('2026-09-18T12:00:03Z')

  beforeEach(() => {
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue({ ...planSuspendido, suspendedAt: PROCESADO_TARDE })
  })

  it('🔴 el pago ANTERIOR al procesamiento del fallo SÍ levanta la suspensión si Stripe dice que está al corriente', async () => {
    const { estadoDeLaSuscripcion } = await import('@/services/stripe.service')
    ;(estadoDeLaSuscripcion as jest.Mock).mockResolvedValue('active')

    await handleInvoicePaymentSucceeded({ ...facturaPagada } as never)

    const escritura = (prisma.venueFeature.update as jest.Mock).mock.calls[0]?.[0]
    expect(escritura?.data).toHaveProperty('suspendedAt', null)
  })

  it('🔴 si Stripe dice que SIGUE DEBIENDO, no la levanta aunque el evento sea reciente', async () => {
    const { estadoDeLaSuscripcion } = await import('@/services/stripe.service')
    ;(estadoDeLaSuscripcion as jest.Mock).mockResolvedValue('past_due')

    await handleInvoicePaymentSucceeded({ ...facturaPagada } as never)

    expect(prisma.venueFeature.update).not.toHaveBeenCalled()
  })

  it('🔴 si no se puede preguntar a Stripe, PROPAGA para que reintente (no decide a ciegas)', async () => {
    const { estadoDeLaSuscripcion } = await import('@/services/stripe.service')
    ;(estadoDeLaSuscripcion as jest.Mock).mockRejectedValue(new Error('Stripe caído'))

    await expect(handleInvoicePaymentSucceeded({ ...facturaPagada } as never)).rejects.toThrow()
    expect(prisma.venueFeature.update).not.toHaveBeenCalled()
  })

  // ⚠️ RETIRADA (6ª auditoría). Fijaba el atajo `if (!suspendedAt) return true`, que resultó ser un
  // hueco: una cancelación deja `active:false` SIN suspensión, y una factura antigua reactivaba el
  // registro sin consultar nada. Lo que sí es cierto —que un registro ya activo y sano no consulta—
  // lo fija «un registro ya ACTIVO y sano no consulta a Stripe» del último describe.
})

/**
 * 🔴 SEXTA AUDITORÍA (Codex xhigh, 19-sep): el enfoque es el correcto, la implementación tenía dos
 * huecos más.
 *
 * 1. **El atajo dejaba pasar la cancelación.** `if (!suspendedAt) return true` asumía que sin
 *    suspensión no hay nada que comprobar. Falso: una cancelación deja `active:false` con
 *    `suspendedAt: null`, así que una factura antigua reactivaba el registro SIN consultar a Stripe.
 *
 * 2. **`trialing` no puede levantar una suspensión por impago.** Aceptarlo escribía además
 *    `endDate: null`, perdiendo el vencimiento de la prueba. Para la PRIMERA activación sí vale
 *    (un trial es acceso legítimo); para levantar una suspensión hace falta `active` de verdad.
 */
describe('qué estado de Stripe autoriza qué', () => {
  it('🔴 un registro CANCELADO (active:false, sin suspensión) SÍ se consulta antes de reactivar', async () => {
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue({ ...planSuspendido, active: false, suspendedAt: null })
    const { estadoDeLaSuscripcion } = await import('@/services/stripe.service')
    ;(estadoDeLaSuscripcion as jest.Mock).mockResolvedValue('canceled')

    await handleInvoicePaymentSucceeded({ ...facturaPagada } as never)

    expect(estadoDeLaSuscripcion).toHaveBeenCalled()
    expect(prisma.venueFeature.update).not.toHaveBeenCalled()
  })

  it('🔴 `trialing` NO levanta una suspensión por impago', async () => {
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue({ ...planSuspendido, suspendedAt: new Date('2026-09-18T00:00:00Z') })
    const { estadoDeLaSuscripcion } = await import('@/services/stripe.service')
    ;(estadoDeLaSuscripcion as jest.Mock).mockResolvedValue('trialing')

    await handleInvoicePaymentSucceeded({ ...facturaPagada } as never)

    expect(prisma.venueFeature.update).not.toHaveBeenCalled()
  })

  it('`trialing` SÍ vale para la primera activación (sin suspensión previa)', async () => {
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue({ ...planSuspendido, active: false, suspendedAt: null })
    const { estadoDeLaSuscripcion } = await import('@/services/stripe.service')
    ;(estadoDeLaSuscripcion as jest.Mock).mockResolvedValue('trialing')

    await handleInvoicePaymentSucceeded({ ...facturaPagada } as never)

    expect(prisma.venueFeature.update).toHaveBeenCalled()
  })

  it('un registro ya ACTIVO y sano no consulta a Stripe (no hay nada que decidir)', async () => {
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue({ ...planSuspendido, active: true, suspendedAt: null })
    const { estadoDeLaSuscripcion } = await import('@/services/stripe.service')
    ;(estadoDeLaSuscripcion as jest.Mock).mockClear()

    await handleInvoicePaymentSucceeded({ ...facturaPagada } as never)

    expect(estadoDeLaSuscripcion).not.toHaveBeenCalled()
  })
})
