/**
 * Versiones de la oferta de planes para las pruebas (planes editables, B1).
 *
 * Se escriben a mano, sin pasar por `planOffer.ts`: así una prueba del respaldo o del cálculo del bruto no puede
 * pasar sólo porque el fixture y el código comparten el mismo error.
 */

import { firmarCotizacion, type CotizacionFirmable } from '@/services/billing/comprobanteDeCotizacion'

type Ranura = 'PRO:monthly' | 'PRO:annual' | 'PREMIUM:monthly' | 'PREMIUM:annual'

/** Las bases de hoy, sin IVA, en centavos (las de `planPricing.constants.ts`). */
const NETO_DE_HOY: Record<Ranura, number> = {
  'PRO:monthly': 99900,
  'PRO:annual': 999000,
  'PREMIUM:monthly': 169900,
  'PREMIUM:annual': 1699000,
}

const bruto = (netCents: number) => Math.round((netCents * 116) / 100)

export interface OpcionesDeLaDefinicion {
  /** `stripePriceId` por ranura; lo que falte queda `null`. */
  ids?: Partial<Record<Ranura, string | null>>
  /** Otro neto por ranura; el bruto se recalcula. */
  netos?: Partial<Record<Ranura, number>>
  nombres?: Partial<Record<'FREE' | 'PRO' | 'PREMIUM', string>>
  productos?: Partial<Record<'PRO' | 'PREMIUM', string | null>>
  /** Cambios por plan (en venta, tarjeta, días de prueba); lo demás queda como hoy. */
  planes?: Partial<Record<'PRO' | 'PREMIUM', Partial<{ onSale: boolean; requiresCard: boolean; trialDays: number }>>>
}

/** Una definición guardada válida: lo de hoy (Gratis / Pro / Premium, con tarjeta, 30 días) con los cambios pedidos. */
export function definicionDePrueba(opciones: OpcionesDeLaDefinicion = {}) {
  const { ids = {}, netos = {}, nombres = {}, productos = {}, planes = {} } = opciones
  const precio = (ranura: Ranura) => {
    const netCents = netos[ranura] ?? NETO_DE_HOY[ranura]
    return { netCents, grossCents: bruto(netCents), stripePriceId: ids[ranura] ?? null }
  }
  const plan = (tier: 'PRO' | 'PREMIUM', nombre: string) => ({
    displayName: nombres[tier] ?? nombre,
    onSale: true,
    requiresCard: true,
    trialDays: 30,
    ...planes[tier],
    monthly: precio(`${tier}:monthly`),
    annual: precio(`${tier}:annual`),
    stripeProductName: productos[tier] ?? null,
  })
  return {
    schemaVersion: 1 as const,
    FREE: { displayName: nombres.FREE ?? 'Gratis' },
    PRO: plan('PRO', 'Pro'),
    PREMIUM: plan('PREMIUM', 'Premium'),
  }
}

/**
 * Un comprobante firmado de verdad (con el `firmarCotizacion` real). Por default: Pro mensual de la v2, $79,900 + IVA
 * (92684 con IVA), 14 días de prueba (primer cobro $0). `emitido` = la hora de emisión (default, ahora).
 */
export function comprobanteDePrueba(c: Partial<CotizacionFirmable> & { alcance: string }, emitido?: Date): string {
  return firmarCotizacion(
    { versionNumber: 2, tier: 'PRO', interval: 'monthly', firstChargeCents: 0, precioCents: 92684, trialEndsAt: null, ...c },
    emitido,
  )
}

/** Los cuatro `priceId` de una versión: `price_<prefijo>_pro_m`, `…_pro_a`, `…_premium_m`, `…_premium_a`. */
export function idsDeLaVersion(prefijo: string): Record<Ranura, string> {
  return {
    'PRO:monthly': `price_${prefijo}_pro_m`,
    'PRO:annual': `price_${prefijo}_pro_a`,
    'PREMIUM:monthly': `price_${prefijo}_premium_m`,
    'PREMIUM:annual': `price_${prefijo}_premium_a`,
  }
}

/** Lo que devuelve `planOfferPointer.findUnique` con una versión vigente (publicada). */
export function punteroA(versionId: string, number: number, definition: unknown) {
  return {
    id: 'vigente',
    currentVersionId: versionId,
    pendingVersionId: null,
    revision: number,
    currentVersion: { id: versionId, number, status: 'PUBLISHED', definition },
  }
}

/** La v1 sembrada: lo de hoy con los cuatro precios de las llaves (`price_v1_*`). */
export function versionUno() {
  return definicionDePrueba({ ids: idsDeLaVersion('v1') })
}

// ---------------------------------------------------------------------------------------------------------------------
// El sembrado de la v1 (Task 3)
// ---------------------------------------------------------------------------------------------------------------------

/** Un precio de Stripe de llave de plan, como lo devuelve `prices.list`. */
export function precioDeStripe(id: string, product: string, unitAmount: number, interval: 'month' | 'year', extra: object = {}) {
  return {
    id,
    object: 'price',
    product,
    unit_amount: unitAmount,
    currency: 'mxn',
    tax_behavior: 'inclusive',
    active: true,
    lookup_key: null as string | null,
    recurring: { interval, interval_count: 1 },
    ...extra,
  }
}

/** La definición de la lista híbrida de un plan a `price` pesos con IVA al mes (la de `seedPlanList`). */
export function definicionDeLaListaDelPlan(tier: 'PRO' | 'PREMIUM', price: number) {
  return {
    schemaVersion: 1,
    kind: 'PLAN',
    planTier: tier,
    terms: { currency: 'MXN', interval: 'MONTHLY', price, taxIncluded: true, promotionCycles: null, renewal: { kind: 'SAME_PRICE' } },
  }
}

/**
 * Lo que Stripe y la base tienen hoy cuando la v1 se puede sembrar (el caso CREATE): las cuatro llaves en el producto de su
 * plan, con el monto de hoy, y las dos listas `PLAN:*` en venta a su precio. Escrito a mano (no desde las constantes).
 */
export function escenarioDelSembrado() {
  return {
    features: [
      { code: 'PLAN_PRO', active: true, stripeProductId: 'prod_pro' },
      { code: 'PLAN_PREMIUM', active: true, stripeProductId: 'prod_premium' },
    ],
    precios: {
      plan_pro_monthly: precioDeStripe('price_key_pro_m', 'prod_pro', 115884, 'month', { lookup_key: 'plan_pro_monthly' }),
      plan_pro_annual: precioDeStripe('price_key_pro_a', 'prod_pro', 1158840, 'year', { lookup_key: 'plan_pro_annual' }),
      plan_premium_monthly: precioDeStripe('price_key_premium_m', 'prod_premium', 197084, 'month', { lookup_key: 'plan_premium_monthly' }),
      plan_premium_annual: precioDeStripe('price_key_premium_a', 'prod_premium', 1970840, 'year', { lookup_key: 'plan_premium_annual' }),
    } as Record<string, ReturnType<typeof precioDeStripe> | undefined>,
    listas: [
      { id: 'list_pro', listProductKey: 'PLAN:PRO', status: 'ACTIVE', currentPublicationId: 'pub_pro', pendingPublicationId: null },
      {
        id: 'list_premium',
        listProductKey: 'PLAN:PREMIUM',
        status: 'ACTIVE',
        currentPublicationId: 'pub_premium',
        pendingPublicationId: null,
      },
    ] as Array<{
      id: string
      listProductKey: string
      status: string
      currentPublicationId: string | null
      pendingPublicationId: string | null
    }>,
    publicaciones: [
      { id: 'pub_pro', definition: definicionDeLaListaDelPlan('PRO', 1158.84) },
      { id: 'pub_premium', definition: definicionDeLaListaDelPlan('PREMIUM', 1970.84) },
    ] as Array<{ id: string; definition: unknown }>,
    nombres: { prod_pro: 'Plan Avoqado Pro', prod_premium: 'Plan Avoqado Premium' } as Record<string, string>,
  }
}

export type EscenarioDelSembrado = ReturnType<typeof escenarioDelSembrado>

/**
 * Monta el escenario sobre el `prismaMock` y los `jest.fn` de Stripe de la prueba. `prices.list` contesta por la llave pedida;
 * `subscriptions.list`, sin suscripciones.
 */
export function montarEscenarioDelSembrado(
  e: EscenarioDelSembrado,
  mocks: { prisma: any; pricesList: jest.Mock; productsRetrieve: jest.Mock; subscriptionsList: jest.Mock },
) {
  mocks.prisma.planOfferPointer.findUnique.mockReset().mockResolvedValue(null)
  mocks.prisma.feature.findMany.mockReset().mockResolvedValue(e.features)
  mocks.prisma.hybridCampaign.findMany.mockReset().mockResolvedValue(e.listas)
  mocks.prisma.hybridOfferPublication.findMany
    .mockReset()
    .mockImplementation(async (args: { where: { id: { in: string[] } } }) => e.publicaciones.filter(p => args.where.id.in.includes(p.id)))
  mocks.prisma.planOfferVersion.create.mockReset().mockResolvedValue({ id: 'cv1' })
  mocks.prisma.planOfferPointer.upsert.mockReset().mockResolvedValue({ id: 'vigente' })
  mocks.prisma.activityLog.create.mockReset().mockResolvedValue({ id: 'log1' })
  mocks.pricesList.mockReset().mockImplementation(async (params: { lookup_keys: string[] }) => {
    const precio = e.precios[params.lookup_keys[0]]
    return { object: 'list', data: precio ? [precio] : [], has_more: false }
  })
  mocks.productsRetrieve.mockReset().mockImplementation(async (id: string) => ({ id, name: e.nombres[id] ?? null }))
  mocks.subscriptionsList.mockReset().mockResolvedValue({ object: 'list', data: [], has_more: false })
}
