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
  // 🔴 9ª auditoría: este mock es INDEPENDIENTE de `estadoDeLaSuscripcion`, no delega en él.
  // Delegar ataba las dos consultas a la misma respuesta y volvía INVISIBLE el defecto que Codex
  // reprodujo: `subscription.updated` consultaba Stripe DOS veces (guard y rama) y podía decidir
  // con una foto y escribir con la otra. Separados, un test puede hacerlos divergir a propósito.
  suscripcionVigente: jest.fn(),
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
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getServer: jest.fn(() => ({})), broadcastToVenue: jest.fn() },
}))
jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))
jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendTrialEndingEmail: jest.fn() } }))
jest.mock('@/services/dashboard/notification.dashboard.service', () => ({ createNotification: jest.fn() }))

import Stripe from 'stripe'
import prisma from '@/utils/prismaClient'
import { handleInvoicePaymentSucceeded } from '@/services/stripe.webhook.service'

/** Un plan SUSPENDIDO por falta de pago: `active:false` y `suspendedAt` con fecha. */
const FECHA_LEIDA = new Date('2026-09-19T10:00:00.000Z')

const planSuspendido = {
  id: 'vf1',
  updatedAt: FECHA_LEIDA,
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
  ;(prisma.venueFeature.updateMany as jest.Mock)?.mockResolvedValue?.({ count: 1 })
  ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue(planSuspendido)
  ;(prisma.venueFeature.update as jest.Mock).mockResolvedValue({})
  // Por defecto Stripe dice que está al corriente: el caso normal es «pagó y se recupera».
  // 🔴 Se restablecen las DOS, explícitamente: `jest.clearAllMocks()` borra el historial de llamadas
  // pero NO las implementaciones, así que un `mockResolvedValue` de un test se filtraba al siguiente.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const stripeSvc = require('@/services/stripe.service')
  ;(stripeSvc.estadoDeLaSuscripcion as jest.Mock).mockResolvedValue('active')
  ;(stripeSvc.suscripcionVigente as jest.Mock).mockResolvedValue({ status: 'active', trialEnd: null })
})

describe('recuperar el pago devuelve el ACCESO, no sólo el flag `active`', () => {
  it('🔴 limpia `suspendedAt`: si se queda puesto, el resolver sigue negando aunque ya pagó', async () => {
    await handleInvoicePaymentSucceeded(facturaPagada)

    const escritura = ((prisma.venueFeature.update as jest.Mock).mock.calls[0] ??
      (prisma.venueFeature.updateMany as jest.Mock).mock.calls[0])?.[0]
    expect(escritura?.data).toHaveProperty('suspendedAt', null)
  })

  it('🔴 y pone el contador de fallos en cero: si no, el siguiente tropiezo suspende de inmediato', async () => {
    await handleInvoicePaymentSucceeded(facturaPagada)

    const escritura = ((prisma.venueFeature.update as jest.Mock).mock.calls[0] ??
      (prisma.venueFeature.updateMany as jest.Mock).mock.calls[0])?.[0]
    expect(escritura?.data).toHaveProperty('paymentFailureCount', 0)
  })

  it('sigue reactivando el plan, que es lo que ya hacía bien', async () => {
    await handleInvoicePaymentSucceeded(facturaPagada)

    const escritura = ((prisma.venueFeature.update as jest.Mock).mock.calls[0] ??
      (prisma.venueFeature.updateMany as jest.Mock).mock.calls[0])?.[0]
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

    const escritura = ((prisma.venueFeature.update as jest.Mock).mock.calls[0] ??
      (prisma.venueFeature.updateMany as jest.Mock).mock.calls[0])?.[0]
    expect(escritura?.data).toHaveProperty('suspendedAt', null)
  })

  it('🔴 y pone el contador de fallos en cero, igual que el otro camino', async () => {
    const { handleSubscriptionUpdated } = await import('@/services/stripe.webhook.service')
    await handleSubscriptionUpdated(suscripcionActiva)

    const escritura = ((prisma.venueFeature.update as jest.Mock).mock.calls[0] ??
      (prisma.venueFeature.updateMany as jest.Mock).mock.calls[0])?.[0]
    expect(escritura?.data).toHaveProperty('paymentFailureCount', 0)
  })

  it('sigue activando el plan y borrando el fin de vigencia, que es lo que ya hacía bien', async () => {
    const { handleSubscriptionUpdated } = await import('@/services/stripe.webhook.service')
    await handleSubscriptionUpdated(suscripcionActiva)

    const escritura = ((prisma.venueFeature.update as jest.Mock).mock.calls[0] ??
      (prisma.venueFeature.updateMany as jest.Mock).mock.calls[0])?.[0]
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

    const escritura = ((prisma.venueFeature.update as jest.Mock).mock.calls[0] ??
      (prisma.venueFeature.updateMany as jest.Mock).mock.calls[0])?.[0]
    expect(escritura?.data).toHaveProperty('suspendedAt', null)
  })

  it('🔴 y la aserción es ESTRICTA: la clave no puede llegar como `undefined`', async () => {
    await handleInvoicePaymentSucceeded({ ...facturaPagada } as never)

    const escritura = ((prisma.venueFeature.update as jest.Mock).mock.calls[0] ??
      (prisma.venueFeature.updateMany as jest.Mock).mock.calls[0])?.[0]
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

    const escritura = ((prisma.venueFeature.update as jest.Mock).mock.calls[0] ??
      (prisma.venueFeature.updateMany as jest.Mock).mock.calls[0])?.[0]
    expect(escritura?.data).toHaveProperty('suspendedAt', null)
  })

  it('🔴 si Stripe dice que SIGUE DEBIENDO, no la levanta aunque el evento sea reciente', async () => {
    const { estadoDeLaSuscripcion } = await import('@/services/stripe.service')
    ;(estadoDeLaSuscripcion as jest.Mock).mockResolvedValue('past_due')

    await handleInvoicePaymentSucceeded({ ...facturaPagada } as never)

    expect(prisma.venueFeature.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 si no se puede preguntar a Stripe, PROPAGA para que reintente (no decide a ciegas)', async () => {
    const { estadoDeLaSuscripcion } = await import('@/services/stripe.service')
    ;(estadoDeLaSuscripcion as jest.Mock).mockRejectedValue(new Error('Stripe caído'))

    await expect(handleInvoicePaymentSucceeded({ ...facturaPagada } as never)).rejects.toThrow()
    expect(prisma.venueFeature.updateMany).not.toHaveBeenCalled()
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
    expect(prisma.venueFeature.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 `trialing` NO levanta una suspensión por impago', async () => {
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue({ ...planSuspendido, suspendedAt: new Date('2026-09-18T00:00:00Z') })
    const { estadoDeLaSuscripcion } = await import('@/services/stripe.service')
    ;(estadoDeLaSuscripcion as jest.Mock).mockResolvedValue('trialing')

    await handleInvoicePaymentSucceeded({ ...facturaPagada } as never)

    expect(prisma.venueFeature.updateMany).not.toHaveBeenCalled()
  })

  it('`trialing` SÍ vale para la primera activación (sin suspensión previa)', async () => {
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue({ ...planSuspendido, active: false, suspendedAt: null })
    const { estadoDeLaSuscripcion } = await import('@/services/stripe.service')
    ;(estadoDeLaSuscripcion as jest.Mock).mockResolvedValue('trialing')

    await handleInvoicePaymentSucceeded({ ...facturaPagada } as never)

    expect(prisma.venueFeature.updateMany).toHaveBeenCalled()
  })

  it('un registro ya ACTIVO y sano no consulta a Stripe (no hay nada que decidir)', async () => {
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue({ ...planSuspendido, active: true, suspendedAt: null })
    const { estadoDeLaSuscripcion } = await import('@/services/stripe.service')
    ;(estadoDeLaSuscripcion as jest.Mock).mockClear()

    await handleInvoicePaymentSucceeded({ ...facturaPagada } as never)

    expect(estadoDeLaSuscripcion).not.toHaveBeenCalled()
  })
})

/**
 * 🔴 AUDITORÍAS 7ª y 8ª (Codex xhigh, 19-sep): `subscription.updated` decidía —y ESCRIBÍA— con la
 * foto que traía el evento, que puede estar vencida porque Stripe no ordena las entregas.
 *
 * Ahora tanto la rama del `switch` como los datos que se escriben salen del estado VIGENTE
 * (`suscripcionVigente`: status + trial_end). Los cinco cruces que se reprodujeron:
 */
describe('subscription.updated: manda el estado VIGENTE, no el del evento', () => {
  const sub = (status: string, trialEnd: number | null = null) =>
    ({ id: 'sub_pro', status, trial_end: trialEnd, current_period_end: 1790000000 }) as never

  const vigente = async (status: string, trialEnd: Date | null = null) => {
    const m = await import('@/services/stripe.service')
    ;(m.estadoDeLaSuscripcion as jest.Mock).mockResolvedValue(status)
    ;(m.suscripcionVigente as jest.Mock).mockResolvedValue({ status, trialEnd })
  }
  const escrituras = () =>
    [...(prisma.venueFeature.update as jest.Mock).mock.calls, ...(prisma.venueFeature.updateMany as jest.Mock).mock.calls].map(
      c => c[0]?.data ?? {},
    )

  it('🔴 aviso atrasado `trialing` sobre un CANCELADO: no reactiva', async () => {
    const { handleSubscriptionUpdated } = await import('@/services/stripe.webhook.service')
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue({ ...planSuspendido, active: false, suspendedAt: null })
    await vigente('canceled')

    await handleSubscriptionUpdated(sub('trialing'))

    // Llegó hasta la decisión (consultó el vigente) y aun así no reactivó: sin esta primera
    // aserción la prueba pasaría también si el manejador hubiera salido antes de decidir nada.
    expect((await import('@/services/stripe.service')).suscripcionVigente).toHaveBeenCalledTimes(1)
    expect(escrituras().some(d => d.active === true)).toBe(false)
  })

  it('🔴 aviso atrasado `unpaid` con Stripe al corriente: NO desactiva a quien paga', async () => {
    const { handleSubscriptionUpdated } = await import('@/services/stripe.webhook.service')
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue({ ...planSuspendido, active: true, suspendedAt: null })
    await vigente('active')

    await handleSubscriptionUpdated(sub('unpaid'))

    expect((await import('@/services/stripe.service')).suscripcionVigente).toHaveBeenCalledTimes(1)
    expect(escrituras().some(d => d.active === false)).toBe(false)
  })

  it('🔴 aviso atrasado `incomplete` con Stripe al corriente: tampoco desactiva (8ª auditoría)', async () => {
    const { handleSubscriptionUpdated } = await import('@/services/stripe.webhook.service')
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue({ ...planSuspendido, active: true, suspendedAt: null })
    await vigente('active')

    await handleSubscriptionUpdated(sub('incomplete'))

    expect((await import('@/services/stripe.service')).suscripcionVigente).toHaveBeenCalledTimes(1)
    expect(escrituras().some(d => d.active === false)).toBe(false)
  })

  it('🔴 aviso atrasado `trialing` sobre un plan HOY PAGADO: no le repone un vencimiento viejo (8ª)', async () => {
    const { handleSubscriptionUpdated } = await import('@/services/stripe.webhook.service')
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue({ ...planSuspendido, active: true, suspendedAt: null })
    await vigente('active')

    const vencidoHaceUnMes = Math.floor(new Date('2026-08-19T00:00:00Z').getTime() / 1000)
    await handleSubscriptionUpdated(sub('trialing', vencidoHaceUnMes))

    // Va por la rama `active` (la vigente): el update DEBE ocurrir, y deja el plan sin vencimiento
    // —no con uno ya pasado—. Exigir la escritura es lo que impide que la prueba pase en vacío.
    expect(escrituras()).toHaveLength(1)
    expect(escrituras()[0]).toHaveProperty('endDate', null)
  })

  it('🔴 aviso `active` con la suscripción HOY en trial: no le borra el vencimiento (8ª)', async () => {
    const { handleSubscriptionUpdated } = await import('@/services/stripe.webhook.service')
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue({ ...planSuspendido, active: true, suspendedAt: null })
    const finDelTrial = new Date('2026-10-01T00:00:00Z')
    await vigente('trialing', finDelTrial)

    await handleSubscriptionUpdated(sub('active'))

    // Va por la rama `trialing` (la vigente): escribe EL vencimiento vigente, nunca `null`.
    expect(escrituras()).toHaveLength(1)
    expect(escrituras()[0]).toHaveProperty('endDate', finDelTrial)
  })

  /**
   * 🔴 9ª AUDITORÍA (Codex xhigh, 19-sep) — EL BLOQUEANTE: dos consultas a Stripe en el mismo
   * manejador son dos fotos distintas. El guard preguntaba por su cuenta (`procedeActivar` →
   * `estadoDeLaSuscripcion`) mientras el `switch` usaba la respuesta de `suscripcionVigente`:
   * entre una y otra el estado puede cambiar y se autoriza con una foto y se escribe con la otra.
   *
   * Las dos pruebas siguientes hacen DIVERGIR los mocks a propósito — algo que era imposible
   * mientras uno delegaba en el otro.
   */
  it('🔴 con el registro SUSPENDIDO y las dos consultas en desacuerdo, NO deja `active:true` con `suspendedAt` puesto', async () => {
    const { handleSubscriptionUpdated } = await import('@/services/stripe.webhook.service')
    const m = await import('@/services/stripe.service')
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue({ ...planSuspendido })
    // Vigente: sigue en trial (no salda la deuda). La consulta VIEJA del guard decía 'active'.
    ;(m.suscripcionVigente as jest.Mock).mockResolvedValue({ status: 'trialing', trialEnd: null })
    ;(m.estadoDeLaSuscripcion as jest.Mock).mockResolvedValue('active')

    await handleSubscriptionUpdated(sub('trialing'))

    // Con el defecto: el guard pasaba con 'active' y la rama 'trialing' escribía `active:true`
    // SIN limpiar `suspendedAt` ⇒ el negocio paga y el resolver le sigue negando el acceso.
    expect(escrituras().some(d => d.active === true)).toBe(false)
  })

  it('🔴 consulta a Stripe UNA sola vez: el guard no puede pedir su propia foto', async () => {
    const { handleSubscriptionUpdated } = await import('@/services/stripe.webhook.service')
    const m = await import('@/services/stripe.service')
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue({ ...planSuspendido, active: false, suspendedAt: null })
    ;(m.suscripcionVigente as jest.Mock).mockResolvedValue({ status: 'active', trialEnd: null })

    await handleSubscriptionUpdated(sub('active'))

    expect(m.suscripcionVigente as jest.Mock).toHaveBeenCalledTimes(1)
    expect(m.estadoDeLaSuscripcion as jest.Mock).not.toHaveBeenCalled()
  })

  it('🔴 el socket avisa con el estado VIGENTE, no con el del aviso atrasado', async () => {
    const { handleSubscriptionUpdated } = await import('@/services/stripe.webhook.service')
    const sockets = (await import('@/communication/sockets')).default as unknown as { broadcastToVenue: jest.Mock }
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue({ ...planSuspendido, active: true, suspendedAt: null })
    await vigente('canceled')

    // El aviso llega diciendo 'active' aunque la suscripción ya está cancelada.
    await handleSubscriptionUpdated(sub('active'))

    // Se desactiva (manda el vigente) y el aviso al dashboard NO puede decir 'active': sería un
    // evento `subscription.deactivated` que se contradice a sí mismo.
    const emitido = sockets.broadcastToVenue.mock.calls.find(c => c[1] === 'subscription.deactivated')
    expect(emitido).toBeDefined()
    expect(emitido![2]).toHaveProperty('status', 'canceled')
  })

  /**
   * 🔴 PASADA DE CIERRE: la OTRA mitad del rescate. `fulfillPlanCheckout` guarda el vínculo
   * inactivo cuando niega el acceso; esta prueba comprueba que el camino endurecido lo RECOGE
   * cuando el pago prospera. Sin las dos mitades, el cliente que paga tarde se queda sin plan.
   */
  it('🔴 recoge el registro INACTIVO que dejó un checkout negado, y lo activa cuando Stripe ya está al corriente', async () => {
    const { handleSubscriptionUpdated } = await import('@/services/stripe.webhook.service')
    // Lo que deja fulfillPlanCheckout al negar: vínculo puesto, acceso NO concedido.
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue({
      ...planSuspendido,
      active: false,
      suspendedAt: null,
      stripeSubscriptionId: 'sub_pro',
    })
    await vigente('active')

    await handleSubscriptionUpdated(sub('active'))

    expect(escrituras()).toHaveLength(1)
    expect(escrituras()[0]).toMatchObject({ active: true, suspendedAt: null, endDate: null })
  })

  /**
   * 🔴 LA CAUSA RAÍZ DE LAS CARRERAS QUE QUEDABAN (Codex, 19-sep): el manejador leía el registro,
   * consultaba Stripe y después escribía condicionado SÓLO por `id`. Entre la lectura y la
   * escritura cabe otro webhook — una suspensión, una cancelación ya procesada — y esta escritura
   * la pisaba. Ahora la escritura es CAS sobre `active` y `suspendedAt`: si cambiaron, no se pisa
   * y el evento se reintenta con datos frescos.
   */
  it('🔴 escribe con CAS sobre lo que leyó, no sólo por id', async () => {
    const { handleSubscriptionUpdated } = await import('@/services/stripe.webhook.service')
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue({ ...planSuspendido, active: false, suspendedAt: null })
    await vigente('active')

    await handleSubscriptionUpdated(sub('active'))

    expect(prisma.venueFeature.updateMany).toHaveBeenCalled()
    const { where } = (prisma.venueFeature.updateMany as jest.Mock).mock.calls[0][0]
    // 🔴 El CAS va por `updatedAt`, no por los campos: Codex demostró que comparar `active` +
    // `suspendedAt` NO detecta a un escritor que reescribe el MISMO valor (una cancelación que
    // pone `active:false` sobre un `false`). Prisma mueve `updatedAt` en cada escritura, así que
    // ese caso sí se detecta — y ningún escritor tiene que acordarse de incrementar nada.
    expect(where).toMatchObject({ id: planSuspendido.id, updatedAt: FECHA_LEIDA })
  })

  it('🔴 una cancelación que reescribe el MISMO valor también se detecta (el caso que los campos no veían)', async () => {
    const { handleSubscriptionUpdated } = await import('@/services/stripe.webhook.service')
    // A lee `active:false`; B procesa la cancelación y vuelve a escribir `active:false`.
    // Comparando campos, A no notaba nada y reactivaba una cancelación ya procesada.
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue({ ...planSuspendido, active: false, suspendedAt: null })
    await vigente('active')
    ;(prisma.venueFeature.updateMany as jest.Mock).mockResolvedValue({ count: 0 })

    await expect(handleSubscriptionUpdated(sub('active'))).rejects.toThrow(/cambió|reintent/i)

    // Lo que hace detectable ese caso es que el CAS mira la marca de tiempo, no los valores.
    const { where } = (prisma.venueFeature.updateMany as jest.Mock).mock.calls[0][0]
    expect(where).toHaveProperty('updatedAt', FECHA_LEIDA)
    expect(where).not.toHaveProperty('active')
  })

  it('🔴 si otro webhook tocó el registro en medio, NO lo pisa y se reintenta', async () => {
    const { handleSubscriptionUpdated } = await import('@/services/stripe.webhook.service')
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue({ ...planSuspendido, active: false, suspendedAt: null })
    await vigente('active')
    // Una suspensión (o una cancelación) se escribió entre nuestra lectura y esta escritura.
    ;(prisma.venueFeature.updateMany as jest.Mock).mockResolvedValue({ count: 0 })

    await expect(handleSubscriptionUpdated(sub('active'))).rejects.toThrow(/cambió|reintent/i)
  })

  it('un moroso REAL sí se desactiva: el candado no vuelve inerte al handler', async () => {
    const { handleSubscriptionUpdated } = await import('@/services/stripe.webhook.service')
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue({ ...planSuspendido, active: true, suspendedAt: null })
    await vigente('unpaid')

    await handleSubscriptionUpdated(sub('unpaid'))

    expect(escrituras().some(d => d.active === false)).toBe(true)
  })
})

/**
 * 🔴 AUDITORÍA 7ª/8ª: la primera activación en TRIAL conservaba… o no… su vencimiento.
 *
 * `endDate: null` significa «pagado, sin vencimiento». Escribirlo siempre convertía una prueba
 * gratuita en acceso permanente. Ahora se reserva para `active`.
 *
 * ⚠️ Las aserciones son ESTRICTAS a propósito: Codex señaló que `not.toBeNull()` acepta `undefined`
 * y pasa incluso si no hubo escritura. Aquí se exige que el update ocurriera Y qué escribió.
 */
describe('una activación en TRIAL conserva su vencimiento', () => {
  it('🔴 con estado vigente `trialing` NO escribe `endDate: null`', async () => {
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue({ ...planSuspendido, active: false, suspendedAt: null })
    const m = await import('@/services/stripe.service')
    ;(m.estadoDeLaSuscripcion as jest.Mock).mockResolvedValue('trialing')

    await handleInvoicePaymentSucceeded({ ...facturaPagada } as never)

    expect(prisma.venueFeature.updateMany).toHaveBeenCalled()
    const data = (prisma.venueFeature.updateMany as jest.Mock).mock.calls[0][0].data
    expect(data.active).toBe(true)
    expect(Object.keys(data)).not.toContain('endDate')
  })

  it('con estado vigente `active` sí lo borra (plan pagado, sin vencimiento)', async () => {
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue({ ...planSuspendido, active: false, suspendedAt: null })
    const m = await import('@/services/stripe.service')
    ;(m.estadoDeLaSuscripcion as jest.Mock).mockResolvedValue('active')

    await handleInvoicePaymentSucceeded({ ...facturaPagada } as never)

    expect(prisma.venueFeature.updateMany).toHaveBeenCalled()
    const data = (prisma.venueFeature.updateMany as jest.Mock).mock.calls[0][0].data
    expect(data).toHaveProperty('endDate', null)
  })
})
