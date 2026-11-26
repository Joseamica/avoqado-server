/**
 * Planes editables B2, Task 7 (§17, §18): lo que «Tu plan» cotiza con la versión del editor.
 *
 * - Sin versión del editor, `null`: «Tu plan» sale como hoy.
 * - Con una prueba SIN tarjeta (`metadata.sinTarjeta`, ruling P6) se dice qué tarjeta cobraría Stripe y cuánto (la vista previa de
 *   Stripe, que ya aplica el saldo): `SIN_TARJETA`, `CON_TARJETA` o `TERMINADA` (b2-r6 #4). Sin prueba sin tarjeta, las opciones de
 *   compra de la versión (firmadas para `venue:<id>`), sin llamadas nuevas a Stripe.
 * - `aceptacionPendiente` (b2-r8 #7) sólo mientras la aceptación no se usó (b2-r9 #5).
 *
 * El resumen de la suscripción sale del `retrievePlanSubscription` REAL (lo que `GET /plan` ya lee), con Stripe simulado; la base es
 * el `prismaMock`.
 */
const mockSubRetrieve = jest.fn()
const mockSubList = jest.fn()
const mockCustomerRetrieve = jest.fn()
const mockRetrieveSource = jest.fn()
const mockPmRetrieve = jest.fn()
const mockCreatePreview = jest.fn()
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    subscriptions: { retrieve: mockSubRetrieve, list: mockSubList },
    customers: { retrieve: mockCustomerRetrieve, retrieveSource: mockRetrieveSource },
    paymentMethods: { retrieve: mockPmRetrieve },
    invoices: { createPreview: mockCreatePreview },
  })),
)

import { prismaMock } from '@tests/__helpers__/setup'
import { aceptacionSinUsar, cotizacionDeTuPlan } from '@/services/billing/cotizacionDeLaOferta'
import { verificarCotizacion } from '@/services/billing/comprobanteDeCotizacion'
import { retrievePlanSubscription } from '@/services/stripe.service'
import type { PlanState } from '@/services/dashboard/planState.service'
import { definicionDePrueba, idsDeLaVersion, punteroA, versionUno } from '@tests/__helpers__/planOfferFixtures'

const DIA = 86_400_000
/** El tope de cada lectura que sólo informa (Task 6): 5 s y sin reintentos. */
const TOPE = { timeout: 5_000, maxNetworkRetries: 0 }
const ahora = new Date()
const FIN_S = Math.floor((ahora.getTime() + 14 * DIA) / 1000)
const FIN_ISO = new Date(FIN_S * 1000).toISOString()
const PRO_M = 92684 // 79900 + IVA

/** La v2 del editor: Pro mensual a $799 + IVA; lo demás como hoy. */
const v2 = (planes: NonNullable<Parameters<typeof definicionDePrueba>[0]>['planes'] = {}) =>
  definicionDePrueba({ ids: idsDeLaVersion('v2'), netos: { 'PRO:monthly': 79900 }, planes })
const conVigente = (number: number, definition: unknown) =>
  prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA(`cv${number}`, number, definition) as never)

const NO_ORIGIN = {
  kind: 'NONE',
  tier: null,
  price: null,
  interval: null,
  currentPeriodEnd: null,
  cancelAt: null,
  contractId: null,
  contractRevision: null,
  subscriptionId: null,
  paymentIssue: null,
}
const BASE = {
  price: null,
  trialEndsAt: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  suspendedAt: null,
  gracePeriodEndsAt: null,
  paymentMethod: null,
  grandfathered: false,
  retentionOfferEligible: false,
  pauseOfferEligible: false,
  basicPlan: null,
  basicOffer: null,
}
/** Un negocio en Gratis (sin fila de plan). */
const enGratis = () =>
  ({
    ...BASE,
    hasPlan: false,
    state: 'none',
    planTier: null,
    planName: null,
    interval: null,
    stripeSubscriptionId: null,
    origin: NO_ORIGIN,
  }) as unknown as PlanState
/** Un negocio con Pro en Stripe (`CLASSIC`), en prueba. */
const enPro = (o: Record<string, unknown> = {}) =>
  ({
    ...BASE,
    hasPlan: true,
    state: 'trial',
    planTier: 'PRO',
    planName: 'Plan Pro',
    interval: 'month',
    stripeSubscriptionId: 'sub_1',
    origin: { ...NO_ORIGIN, kind: 'CLASSIC', tier: 'PRO', interval: 'month', subscriptionId: 'sub_1' },
    ...o,
  }) as unknown as PlanState
/** Una prueba regalada de Pro (`COMP`). */
const enPruebaRegalada = () =>
  ({
    ...BASE,
    hasPlan: true,
    state: 'trial',
    planTier: 'PRO',
    planName: 'Plan Pro',
    interval: null,
    stripeSubscriptionId: null,
    origin: { ...NO_ORIGIN, kind: 'COMP', tier: 'PRO' },
  }) as unknown as PlanState

/** La prueba del alta sin tarjeta tal como la tiene Stripe: `trialing`, sin método y con `missing_payment_method: 'cancel'`. */
const suscripcion = (o: Record<string, unknown> = {}) => ({
  id: 'sub_1',
  object: 'subscription',
  customer: 'cus_1',
  status: 'trialing',
  created: Math.floor(ahora.getTime() / 1000) - 60,
  cancel_at_period_end: false,
  cancel_at: null,
  default_payment_method: null,
  default_source: null,
  trial_end: FIN_S,
  trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
  metadata: { sinTarjeta: 'true', planOfferVersion: '2' },
  discounts: [],
  items: {
    data: [
      {
        current_period_end: FIN_S,
        price: { id: 'price_v2_pro_m', unit_amount: PRO_M, recurring: { interval: 'month' }, product: 'prod_pro' },
      },
    ],
  },
  ...o,
})
const tarjeta = (id: string, brand: string, last4: string) => ({ id, object: 'payment_method', type: 'card', card: { brand, last4 } })
const cliente = (o: Record<string, unknown> = {}) => ({
  id: 'cus_1',
  object: 'customer',
  invoice_settings: { default_payment_method: null },
  default_source: null,
  ...o,
})

/** Lo que `GET /plan` ya leyó de Stripe (`retrievePlanSubscription`), con la suscripción y el cliente de la prueba. */
async function resumen(sub: Record<string, unknown> = {}, cli: Record<string, unknown> = {}) {
  mockSubRetrieve.mockResolvedValue(suscripcion(sub))
  mockCustomerRetrieve.mockResolvedValue(cliente(cli))
  return retrievePlanSubscription('sub_1')
}

/** La fila de plan de una prueba regalada de Pro que termina en `dias` días. */
const filaRegalada = (dias: number) => ({
  id: 'vf_regalada',
  active: true,
  endDate: new Date(ahora.getTime() + dias * DIA),
  suspendedAt: null,
  gracePeriodEndsAt: null,
  stripeSubscriptionId: null,
  updatedAt: ahora,
  feature: { code: 'PLAN_PRO' },
})
/** La fila de Pro ligada a la suscripción de Stripe (la del alta sin tarjeta). */
const filaDeStripe = {
  id: 'vf_pro',
  active: true,
  endDate: new Date(FIN_S * 1000),
  suspendedAt: null,
  gracePeriodEndsAt: null,
  stripeSubscriptionId: 'sub_1',
  updatedAt: ahora,
  feature: { code: 'PLAN_PRO' },
}

/** Una aceptación viva de la conversión de la demo (Task 8). */
const ACEPTACION = {
  id: 'caceptacion00000000000001',
  venueId: 'v1',
  offerVersionId: 'cv3',
  tier: 'PRO',
  interval: 'monthly',
  quoteToken: 'tok',
  validadoAt: ahora,
  createdById: 'staff_1',
  createdAt: ahora,
  expiresAt: new Date(ahora.getTime() + 20 * 60_000),
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.planOfferPointer.findUnique.mockReset().mockResolvedValue(null)
  prismaMock.venueFeature.findMany.mockReset().mockResolvedValue([])
  prismaMock.venue.findUnique.mockReset().mockResolvedValue({ stripeCustomerId: 'cus_1' })
  prismaMock.planAcceptance.findFirst.mockReset().mockResolvedValue(null)
  mockSubRetrieve.mockReset()
  mockSubList.mockReset().mockResolvedValue({ object: 'list', data: [], has_more: false })
  mockCustomerRetrieve.mockReset()
  mockRetrieveSource.mockReset()
  mockPmRetrieve.mockReset().mockImplementation(async (id: string) => {
    if (id === 'pm_oxxo') return { id, object: 'payment_method', type: 'oxxo' }
    throw Object.assign(new Error('No such payment_method'), { code: 'resource_missing', statusCode: 404 })
  })
  mockCreatePreview.mockReset().mockResolvedValue({ object: 'invoice', amount_due: PRO_M, total: PRO_M })
})

describe('cotizacionDeTuPlan', () => {
  it('sin versión del editor → null', async () => {
    expect(await cotizacionDeTuPlan('v1', enGratis(), null, ahora)).toBeNull()
    conVigente(1, versionUno())
    expect(await cotizacionDeTuPlan('v1', enPro(), await resumen(), ahora)).toBeNull()
    // Ni la vista previa, ni la lista de suscripciones: sin versión del editor no hay llamadas nuevas a Stripe.
    expect(mockCreatePreview).not.toHaveBeenCalled()
    expect(mockSubList).not.toHaveBeenCalled()
  })

  it('🔴 SIN_TARJETA: { tarjeta: null, montoAlTerminarCents: amount_due de la vista previa } y todas las opciones en null; con saldo a favor, el amount_due', async () => {
    conVigente(2, v2())
    prismaMock.venueFeature.findMany.mockResolvedValue([filaDeStripe])
    const sub = await resumen()
    expect(sub).toMatchObject({ sinTarjeta: true, faltaTarjeta: true, tarjetaQueCobrara: null })
    // La lectura del cliente para saber qué tarjeta cobraría sólo informa: con tope.
    expect(mockCustomerRetrieve).toHaveBeenCalledWith(
      'cus_1',
      { expand: ['invoice_settings.default_payment_method', 'default_source'] },
      TOPE,
    )

    const c = await cotizacionDeTuPlan(
      'v1',
      enPro({ origin: { ...NO_ORIGIN, kind: 'CLASSIC', tier: 'PRO', faltaTarjeta: true } }),
      sub,
      ahora,
    )

    expect(c).not.toBeNull()
    expect(c!.versionNumber).toBe(2)
    expect(c!.estadoDeLaPrueba).toEqual({
      estado: 'SIN_TARJETA',
      tier: 'PRO',
      interval: 'monthly',
      trialEndsAt: FIN_ISO,
      tarjeta: null,
      montoAlTerminarCents: PRO_M,
    })
    // Comprar otro plan encima lo niega la regla común: ninguna opción.
    expect(c!.planes.PRO).toEqual({ displayName: 'Pro', vendible: false, monthly: null, annual: null })
    expect(c!.planes.PREMIUM).toEqual({ displayName: 'Premium', vendible: false, monthly: null, annual: null })
    expect(c!.aceptacionPendiente).toBeUndefined()
    // La vista previa de ESA suscripción, con tope.
    expect(mockCreatePreview).toHaveBeenCalledWith({ subscription: 'sub_1' }, TOPE)

    // Con saldo a favor en Stripe, lo que de verdad se cobrará: el amount_due (nunca el precio de lista).
    mockCreatePreview.mockResolvedValue({ object: 'invoice', amount_due: 42684, total: PRO_M, starting_balance: -50000 })
    const conSaldo = await cotizacionDeTuPlan('v1', enPro(), sub, ahora)
    expect(conSaldo!.estadoDeLaPrueba).toMatchObject({ estado: 'SIN_TARJETA', montoAlTerminarCents: 42684 })
  })

  it('🔴 b2-r6 #4: la vista previa falla → SIN_TARJETA con montoAlTerminarCents null (la pantalla no ofrece «Poner mi tarjeta»)', async () => {
    conVigente(2, v2())
    mockCreatePreview.mockRejectedValue(Object.assign(new Error('timeout'), { type: 'StripeConnectionError' }))

    const c = await cotizacionDeTuPlan('v1', enPro(), await resumen(), ahora)

    expect(c!.estadoDeLaPrueba).toEqual({
      estado: 'SIN_TARJETA',
      tier: 'PRO',
      interval: 'monthly',
      trialEndsAt: FIN_ISO,
      tarjeta: null,
      montoAlTerminarCents: null,
    })
    expect(c!.planes.PRO.monthly).toBeNull()
  })

  it('🔴 b2-r6 #4: Stripe dice canceled y la fila sigue activa (la baja no llegó) → TERMINADA y las opciones de compra normales', async () => {
    conVigente(2, v2())
    prismaMock.venueFeature.findMany.mockResolvedValue([filaDeStripe])
    // El portal ya dejó una tarjeta en el cliente, pero la prueba terminó: nunca «Listo».
    const sub = await resumen(
      { status: 'canceled', ended_at: FIN_S },
      { invoice_settings: { default_payment_method: tarjeta('pm_portal', 'visa', '4242') } },
    )

    const c = await cotizacionDeTuPlan('v1', enPro(), sub, ahora)

    expect(c!.estadoDeLaPrueba).toEqual({
      estado: 'TERMINADA',
      tier: 'PRO',
      interval: 'monthly',
      trialEndsAt: FIN_ISO,
      tarjeta: null,
      montoAlTerminarCents: null,
    })
    // Como Gratis: la compra normal de la vigente, firmada para este negocio (hoy se paga el precio de la v2).
    const pro = c!.planes.PRO.monthly!
    expect(c!.planes.PRO.vendible).toBe(true)
    expect(pro).toMatchObject({ precioCents: PRO_M, netCents: 79900, firstChargeCents: PRO_M, trialEndsAt: null })
    expect(verificarCotizacion(pro.quoteToken, 'venue:v1', ahora)).toMatchObject({
      versionNumber: 2,
      tier: 'PRO',
      interval: 'monthly',
      precioCents: PRO_M,
      trialEndsAt: null,
    })
    expect(c!.planes.PREMIUM.monthly).not.toBeNull()
    // Nada se cobrará de una prueba terminada: ni la vista previa ni la tarjeta se leen.
    expect(mockCreatePreview).not.toHaveBeenCalled()
    expect(mockCustomerRetrieve).not.toHaveBeenCalled()
  })

  it('🔴 b2-r6 #4: past_due (la prueba terminó y el cobro falló) → sin estadoDeLaPrueba, nunca CON_TARJETA', async () => {
    conVigente(2, v2())
    const sub = await resumen(
      { status: 'past_due' },
      { invoice_settings: { default_payment_method: tarjeta('pm_portal', 'visa', '4242') } },
    )

    const c = await cotizacionDeTuPlan('v1', enPro({ state: 'past_due' }), sub, ahora)

    expect(c).not.toBeNull()
    expect(c!.estadoDeLaPrueba).toBeUndefined()
    expect(mockCreatePreview).not.toHaveBeenCalled()
  })

  it('CON_TARJETA con la tarjeta del cliente (o su default_source) y su monto; con cancel_at_period_end, sin estadoDeLaPrueba', async () => {
    conVigente(2, v2())
    // Lo que deja el portal: la predeterminada del cliente.
    const conPortal = await resumen({}, { invoice_settings: { default_payment_method: tarjeta('pm_portal', 'visa', '4242') } })
    expect(conPortal).toMatchObject({ sinTarjeta: true, faltaTarjeta: false, tarjetaQueCobrara: { brand: 'visa', last4: '4242' } })

    const c = await cotizacionDeTuPlan('v1', enPro(), conPortal, ahora)

    expect(c!.estadoDeLaPrueba).toEqual({
      estado: 'CON_TARJETA',
      tier: 'PRO',
      interval: 'monthly',
      trialEndsAt: FIN_ISO,
      tarjeta: { brand: 'visa', last4: '4242' },
      montoAlTerminarCents: PRO_M,
    })

    // b2-r6 #5: una tarjeta vieja del cliente (`default_source`) también es la que cobraría.
    const conFuente = await resumen({}, { default_source: { id: 'card_1', object: 'card', brand: 'Visa', last4: '1881' } })
    const f = await cotizacionDeTuPlan('v1', enPro(), conFuente, ahora)
    expect(f!.estadoDeLaPrueba).toMatchObject({
      estado: 'CON_TARJETA',
      tarjeta: { brand: 'Visa', last4: '1881' },
      montoAlTerminarCents: PRO_M,
    })

    // Con la cancelación programada nada promete que la prueba sigue: «Tu plan» de hoy ya dice cuándo termina.
    mockCreatePreview.mockClear()
    const cancelando = await resumen(
      { cancel_at_period_end: true },
      { invoice_settings: { default_payment_method: tarjeta('pm_portal', 'visa', '4242') } },
    )
    const sinEstado = await cotizacionDeTuPlan('v1', enPro({ state: 'canceling', cancelAtPeriodEnd: true }), cancelando, ahora)
    expect(sinEstado!.estadoDeLaPrueba).toBeUndefined()
    expect(mockCreatePreview).not.toHaveBeenCalled()
  })

  it('🔴 b2-r7 #3: la predeterminada del cliente es un método que no es card → SIN_TARJETA (y la pantalla ofrece «Poner mi tarjeta»), nunca CON_TARJETA', async () => {
    conVigente(2, v2())
    const sub = await resumen({}, { invoice_settings: { default_payment_method: 'pm_oxxo' } })
    expect(sub).toMatchObject({ faltaTarjeta: true, tarjetaQueCobrara: null })

    const c = await cotizacionDeTuPlan('v1', enPro(), sub, ahora)

    expect(c!.estadoDeLaPrueba).toMatchObject({ estado: 'SIN_TARJETA', tarjeta: null, montoAlTerminarCents: PRO_M })
  })

  it('🔴 b2-r8 #7: una aceptación viva de la demo con la v3 vigente sin ningún plan en venta → aceptacionPendiente { acceptanceId, tier, interval, expiresAt } y los planes vendible false', async () => {
    conVigente(3, definicionDePrueba({ ids: idsDeLaVersion('v3'), planes: { PRO: { onSale: false }, PREMIUM: { onSale: false } } }))
    prismaMock.planAcceptance.findFirst.mockResolvedValue(ACEPTACION)

    const c = await cotizacionDeTuPlan('v1', enGratis(), null, ahora)

    expect(c!.versionNumber).toBe(3)
    expect(c!.aceptacionPendiente).toEqual({
      acceptanceId: ACEPTACION.id,
      tier: 'PRO',
      interval: 'monthly',
      expiresAt: ACEPTACION.expiresAt.toISOString(),
    })
    expect(c!.planes.PRO).toEqual({ displayName: 'Pro', vendible: false, monthly: null, annual: null })
    expect(c!.planes.PREMIUM).toEqual({ displayName: 'Premium', vendible: false, monthly: null, annual: null })
    // La aceptación viva de ESTE negocio, y la lista de suscripciones de su cliente sólo porque existe (con tope).
    expect(prismaMock.planAcceptance.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: 'v1', expiresAt: { gt: ahora } } }),
    )
    expect(mockSubList).toHaveBeenCalledWith({ customer: 'cus_1', status: 'all', limit: 100 }, TOPE)
  })

  it('🔴 b2-r9 #5: la misma aceptación con una suscripción del cliente que trae metadata.planAcceptanceId = su id (active) → sin aceptacionPendiente; con el negocio ya en ese plan (fila trialing) → sin aceptacionPendiente; con la suscripción de la aceptación en incomplete_expired → sí; si subscriptions.list falla → sin aceptacionPendiente', async () => {
    conVigente(3, definicionDePrueba({ ids: idsDeLaVersion('v3'), planes: { PRO: { onSale: false }, PREMIUM: { onSale: false } } }))
    prismaMock.planAcceptance.findFirst.mockResolvedValue(ACEPTACION)
    const conSuscripcion = (status: string) =>
      mockSubList.mockResolvedValue({
        object: 'list',
        has_more: false,
        data: [{ id: 'sub_acept', object: 'subscription', status, metadata: { planAcceptanceId: ACEPTACION.id } }],
      })

    // Ya se pagó: su suscripción vive.
    conSuscripcion('active')
    expect((await cotizacionDeTuPlan('v1', enGratis(), null, ahora))!.aceptacionPendiente).toBeUndefined()

    // El negocio ya está en ese plan: ni se pregunta a Stripe.
    mockSubList.mockClear()
    expect((await cotizacionDeTuPlan('v1', enPro(), null, ahora))!.aceptacionPendiente).toBeUndefined()
    expect(mockSubList).not.toHaveBeenCalled()

    // Su compra venció sin pagarse: la aceptación sigue sin usar.
    conSuscripcion('incomplete_expired')
    expect((await cotizacionDeTuPlan('v1', enGratis(), null, ahora))!.aceptacionPendiente).toMatchObject({ acceptanceId: ACEPTACION.id })

    // «No pude ver» no es «sin usar»: no se ofrece, y lo demás de la cotización sigue.
    mockSubList.mockRejectedValue(Object.assign(new Error('timeout'), { type: 'StripeConnectionError' }))
    const c = await cotizacionDeTuPlan('v1', enGratis(), null, ahora)
    expect(c).not.toBeNull()
    expect(c!.aceptacionPendiente).toBeUndefined()
    await expect(aceptacionSinUsar('v1', enGratis(), 'cus_1', ahora)).rejects.toThrow('timeout')
  })

  it('Gratis (sin plan): opciones de compra sin vista previa; prueba regalada de Pro a 10 días: diferida al fin; Premium fuera de venta: vendible false', async () => {
    conVigente(2, v2({ PREMIUM: { onSale: false } }))

    const gratis = await cotizacionDeTuPlan('v1', enGratis(), null, ahora)

    expect(gratis!.estadoDeLaPrueba).toBeUndefined()
    expect(gratis!.aceptacionPendiente).toBeUndefined()
    expect(gratis!.planes.PRO.vendible).toBe(true)
    expect(gratis!.planes.PRO.monthly).toMatchObject({ precioCents: PRO_M, firstChargeCents: PRO_M, trialEndsAt: null })
    expect(verificarCotizacion(gratis!.planes.PRO.monthly!.quoteToken, 'venue:v1', ahora)).toMatchObject({
      versionNumber: 2,
      precioCents: PRO_M,
    })
    expect(gratis!.planes.PREMIUM).toEqual({ displayName: 'Premium', vendible: false, monthly: null, annual: null })
    // Sin prueba sin tarjeta: ninguna llamada nueva a Stripe.
    expect(mockSubRetrieve).not.toHaveBeenCalled()
    expect(mockCustomerRetrieve).not.toHaveBeenCalled()
    expect(mockCreatePreview).not.toHaveBeenCalled()
    expect(mockSubList).not.toHaveBeenCalled()

    // D3: con una prueba regalada de Pro a 10 días (≥ 72 h), quedarse con Pro paga $0 hoy y cobra al fin de la prueba.
    const fila = filaRegalada(10)
    prismaMock.venueFeature.findMany.mockResolvedValue([fila])
    const regalada = await cotizacionDeTuPlan('v1', enPruebaRegalada(), null, ahora)
    const pro = regalada!.planes.PRO.monthly!
    expect(pro).toMatchObject({ precioCents: PRO_M, firstChargeCents: 0, trialEndsAt: fila.endDate.toISOString() })
    expect(verificarCotizacion(pro.quoteToken, 'venue:v1', ahora).trialEndsAt!.getTime()).toBe(fila.endDate.getTime())
    expect(regalada!.planes.PREMIUM.vendible).toBe(false)
    expect(mockCreatePreview).not.toHaveBeenCalled()
  })
})
