/**
 * S2 — la aritmética de la oferta de lanzamiento (spec 2026-09-17 § 3.1 y § 7.6).
 *
 * 🔴 MÓDULO PURO. Sin base de datos, sin Stripe y **sin reloj**: el `now` entra por parámetro.
 * Todo lo que decide cuánto se cobra vive aquí, donde no hay nada que mockear mal — y por eso
 * es lo primero que se prueba (`tests/unit/services/launchCampaigns/launchOfferMath.test.ts`).
 *
 * 🔴 UNIDADES — excepción DECLARADA a la regla «la plataforma trabaja en PESOS 1:1»
 * (`.claude/rules/critical-warnings.md`). Cada importe de este archivo va en CENTAVOS enteros
 * CON IVA incluido, porque cada uno ES un campo de Stripe (`price.unit_amount`,
 * `coupon.amount_off`), que por contrato del proveedor son centavos. No se convierten a pesos.
 *
 * La oferta real del lanzamiento, y el caso que fija el contrato de los otros tres repos:
 *   PRO mensual de lista $1,158.84 con IVA (115884) → anunciado $22.00 (2200)
 *   cupón `amount_off` = 113684 · 3 facturas a 2200 · de la 4.ª en adelante 115884.
 */

/** IVA mexicano. El precio que se MUESTRA ya lo incluye (regla del workspace: en MX no hay «+ IVA»). */
export const IVA_RATE = 0.16

/**
 * Mínimo que Stripe acepta cobrar en MXN: $10.00 = 1000 centavos.
 * Un precio por debajo produce una ficha que ACTIVA bien y falla al cobrarle al primer cliente,
 * que es el peor momento posible para enterarse. Lo replica un CHECK en la base
 * (`LaunchCampaign_price_min`), para que ninguna escritura —ni por SQL— lo esquive.
 */
export const STRIPE_MIN_CHARGE_CENTS_MXN = 1000

/** Meses que factura un año. `firstYearTotalCents` no puede prometer más de 12 cobros. */
const MONTHS_PER_YEAR = 12

function assertCents(value: number, nombre: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${nombre} debe ser un entero de centavos; llegó ${value}`)
  }
  if (value < 0) {
    throw new Error(`${nombre} no puede ser negativo; llegó ${value}`)
  }
}

/**
 * Desglose de un importe que YA trae el IVA dentro.
 *
 * 🔴 El IVA es el RESIDUO, nunca un cálculo aparte: `subtotal = round(gross / 1.16)` y
 * `iva = gross - subtotal`. Calcular el IVA por su lado (`round(gross * 0.16 / 1.16)`) hace que
 * la suma no siempre devuelva el bruto — y entonces la pantalla muestra «$18.97 + $3.04 = $22.01»
 * sobre un cobro de $22.00. Con el residuo, la suma cuadra POR CONSTRUCCIÓN.
 *
 * Ejemplos del lanzamiento: `115884` → 99900 + 15984 · `2200` → 1897 + 303.
 */
export function splitIvaInclusive(grossCents: number): { subtotalCents: number; ivaCents: number } {
  assertCents(grossCents, 'el importe bruto')
  const subtotalCents = Math.round(grossCents / (1 + IVA_RATE))
  return { subtotalCents, ivaCents: grossCents - subtotalCents }
}

/**
 * 🔴 ¿Este bruto se puede PINTAR como «Subtotal + IVA (16 %)»?
 *
 * La suma del desglose siempre devuelve el bruto (el IVA es el residuo). Lo que NO siempre se
 * cumple es la otra igualdad, que es la que el visitante comprueba con la calculadora del
 * teléfono: `iva === round(subtotal × 0.16)`.
 *
 *   $1,158.84 → 99900 + 15984, y el 16 % de 99900 es 15984  ✅ cuadra
 *   $22.00    → 1897 + 303,    y el 16 % de 1897 es **304**  🔴 NO cuadra
 *
 * Medido el 2026-09-17: 27,448 de los 199,001 brutos entre $10 y $2,000 (13.8 %) caen del lado
 * malo, y el precio estrella del lanzamiento es uno de ellos. No es un cobro equivocado —siempre
 * se cobran $22.00 exactos—, es un DESGLOSE que no se puede etiquetar «16 %».
 *
 * 🔴 Qué tiene que hacer quien consume la vista: si el bloque trae `ivaExact: false`, enseña el
 * bruto («$22.00 IVA incluido») y NO lo parta en dos renglones con la etiqueta del porcentaje.
 * El desglose sigue viajando porque la factura sí lo necesita; lo que no se puede es rotularlo.
 *
 * Y sirve además como aviso al ACTIVAR (S5): un precio limpio —$23.20 = $20.00 + $3.20— no tiene
 * este problema, así que el superadmin puede elegirlo a tiempo en vez de enterarse en la landing.
 */
export function ivaBreakdownIsExact(grossCents: number): boolean {
  const { subtotalCents, ivaCents } = splitIvaInclusive(grossCents)
  return ivaCents === Math.round(subtotalCents * IVA_RATE)
}

/**
 * El `amount_off` que se le manda a Stripe al crear el cupón de la campaña.
 * Es una RESTA, no un porcentaje: un porcentaje redondeado por Stripe daría un cobro de
 * $22.01 o $21.99, y lo que se anunció fue $22.00 exactos.
 */
export function computeCouponAmountOff({
  listPriceCents,
  advertisedPriceCents,
}: {
  listPriceCents: number
  advertisedPriceCents: number
}): number {
  assertCents(listPriceCents, 'el precio de lista')
  assertCents(advertisedPriceCents, 'el precio anunciado')
  if (advertisedPriceCents < STRIPE_MIN_CHARGE_CENTS_MXN) {
    throw new Error(
      `el precio anunciado (${advertisedPriceCents}) está por debajo del mínimo de Stripe en MXN (${STRIPE_MIN_CHARGE_CENTS_MXN} = $10.00)`,
    )
  }
  if (advertisedPriceCents >= listPriceCents) {
    throw new Error(
      `el precio anunciado (${advertisedPriceCents}) debe ser MENOR que el de lista (${listPriceCents}); un cupón de $0 o negativo no existe`,
    )
  }
  return listPriceCents - advertisedPriceCents
}

/** Lo que el cliente paga durante TODA la promoción: 3 × $22.00 = $66.00. */
export function promoPeriodTotalCents({
  advertisedPriceCents,
  discountMonths,
}: {
  advertisedPriceCents: number
  discountMonths: number
}): number {
  assertCents(advertisedPriceCents, 'el precio anunciado')
  if (!Number.isInteger(discountMonths) || discountMonths < 1) {
    throw new Error(`los meses de promoción deben ser un entero mayor que 0; llegaron ${discountMonths}`)
  }
  return advertisedPriceCents * discountMonths
}

/**
 * Lo que el cliente paga en su PRIMER AÑO: los meses promocionales más los que faltan a
 * precio de lista. `3 × 2200 + 9 × 115884 = 1049556` ($10,495.56).
 *
 * 🔴 QUIÉN LO CONSUME, porque hoy no lo llama nadie y eso confunde: es para la vista previa del
 * SUPERADMIN al crear la ficha (S5) — «esta campaña le cuesta al cliente $10,495.56 su primer
 * año» — y para el correo de confirmación. **No entra en la vista pública** (§ 3.3): ahí sólo van
 * el precio promocional, sus meses y la renovación. (`promoPeriodTotalCents` sí entra, como
 * `promo.periodTotalCents`.)
 *
 * 🔴 Una promoción de MÁS de 12 meses no resta meses al primer año: se topa en 12 cobros
 * promocionales y cero de lista. Sin el tope, 24 meses darían `24 × 2200 - 12 × 115884`, un
 * número negativo que la landing pintaría como un descuento imposible.
 */
export function firstYearTotalCents({
  advertisedPriceCents,
  discountMonths,
  listPriceCents,
}: {
  advertisedPriceCents: number
  discountMonths: number
  listPriceCents: number
}): number {
  assertCents(listPriceCents, 'el precio de lista')
  // Se llama por sus VALIDACIONES (centavos enteros, meses >= 1); el total del año se compone
  // aparte, sin dividir nunca: una división sobre centavos mete error de flotante en dinero.
  promoPeriodTotalCents({ advertisedPriceCents, discountMonths })
  // 🔴 El cinturón, además del nombre: una oferta cuyo precio de lista NO es mayor que el
  // anunciado no existe (lo rechazan `computeCouponAmountOff` y el CHECK `_discount_consistent`).
  // Si llega aquí es que alguien armó el objeto al revés, y devolver un número sería peor que
  // lanzar: `{advertised: 115884, months: 3, list: 2200}` daba 367452 — 3.5× mal — en silencio.
  if (listPriceCents <= advertisedPriceCents) {
    throw new Error(
      `el precio de lista (${listPriceCents}) debe ser MAYOR que el anunciado (${advertisedPriceCents}); ¿están intercambiados?`,
    )
  }
  const promoMonths = Math.min(discountMonths, MONTHS_PER_YEAR)
  const listMonths = MONTHS_PER_YEAR - promoMonths
  return advertisedPriceCents * promoMonths + listMonths * listPriceCents
}

export type LaunchOfferPlanTier = 'PRO' | 'PREMIUM'
export type LaunchOfferStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ENDED'
export type LaunchOfferVertical = 'ALL' | 'FOOD_SERVICE' | 'RETAIL' | 'SERVICES' | 'HOSPITALITY' | 'ENTERTAINMENT'

/**
 * Exactamente las columnas de `LaunchCampaign` que la aritmética necesita — ni una más.
 * Es un tipo estructural a propósito: así el módulo no importa el cliente de Prisma (que pesa
 * 49 MB de tipos) y el `select` del controlador queda obligado a ser explícito.
 */
export interface LaunchOfferCampaignRow {
  code: string
  landingSlug: string
  offerVersion: number
  vertical: LaunchOfferVertical
  planTier: LaunchOfferPlanTier
  status: LaunchOfferStatus
  validFrom: Date
  validUntil: Date
  redemptionCap: number
  redemptionCount: number
  advertisedPriceCents: number
  discountMonths: number
  listPriceCentsSnapshot: number | null
  discountAmountCents: number | null
  headline: string | null
  subheadline: string | null
  bullets: string[]
}

/**
 * Los motivos que el SERVIDOR sabe producir hoy. La lista es un `const` de verdad (no sólo un
 * tipo) para que exista en tiempo de ejecución: `isKnownUnavailableReason` la usa, y las pruebas
 * la comparan entera — así, añadir uno obliga a mirar esta lista.
 */
export const LAUNCH_OFFER_UNAVAILABLE_REASONS = ['NOT_STARTED', 'EXPIRED', 'PAUSED', 'ENDED', 'SOLD_OUT', 'NOT_PUBLISHED'] as const

export type LaunchOfferUnavailableReason = (typeof LAUNCH_OFFER_UNAVAILABLE_REASONS)[number]

/**
 * 🔴 EL MOTIVO TAL COMO VIAJA POR EL CABLE — y es un tipo ABIERTO a propósito.
 *
 * Esta lista VA A CRECER. El guardián del precio de lista (P2-5 de la revisión del 2026-09-17)
 * necesita un `PRICE_DRIFT` el día que `ensurePrice` mueva el precio en Stripe debajo de una
 * campaña viva; y cualquier motivo nuevo llega a una landing, un dashboard y un superadmin que
 * ya están desplegados y no se actualizan el mismo día que el servidor.
 *
 * 🔴 LA REGLA DEL CONTRATO, y hay que escribirla HOY porque mañana es un cambio rompedor:
 * **un `unavailableReason` que el cliente no reconozca se trata como «no disponible» a secas** —
 * el texto genérico, nunca un `throw`, nunca una pantalla en blanco y NUNCA el precio.
 *
 * El tipo lo hace cumplir en vez de pedirlo por favor: al ser abierto (`string & {}` conserva el
 * autocompletado de los seis conocidos), un `switch` sin rama por defecto NO COMPILA en el
 * consumidor. `isKnownUnavailableReason` es el estrechador para llegar al texto específico.
 */
export type LaunchOfferUnavailableReasonWire = LaunchOfferUnavailableReason | (string & {})

/** ¿Este motivo es de los que este servidor sabe explicar, o toca el texto genérico? */
export function isKnownUnavailableReason(reason: string): reason is LaunchOfferUnavailableReason {
  return (LAUNCH_OFFER_UNAVAILABLE_REASONS as readonly string[]).includes(reason)
}

/**
 * ¿Se puede vender esta oferta AHORA?
 *
 * 🔴 El ORDEN de los motivos es parte del contrato, porque es el texto que ve el visitante:
 *   1. DRAFT            → NOT_PUBLISHED  (nunca se publicó: gana a «vencida»)
 *   2. ENDED            → ENDED          (terminar es definitivo: gana a pausada y a agotada)
 *   3. PAUSED           → PAUSED         (gana a vencida y a agotada)
 *   4. now < validFrom  → NOT_STARTED
 *   5. now >= validUntil→ EXPIRED        (la ventana es [validFrom, validUntil), gana a agotada)
 *   6. count >= cap     → SOLD_OUT
 *   7. ACTIVE sin los importes congelados → NOT_PUBLISHED
 *
 * El punto 7 es el que evita pintar un precio a medio congelar: una ficha marcada ACTIVE cuyo
 * snapshot de lista o cuyo descuento falten no tiene con qué construir una vista honesta.
 */
export function launchOfferAvailability(
  c: LaunchOfferCampaignRow,
  now: Date,
): { available: true } | { available: false; reason: LaunchOfferUnavailableReason } {
  if (c.status === 'DRAFT') return { available: false, reason: 'NOT_PUBLISHED' }
  if (c.status === 'ENDED') return { available: false, reason: 'ENDED' }
  if (c.status === 'PAUSED') return { available: false, reason: 'PAUSED' }
  if (now.getTime() < c.validFrom.getTime()) return { available: false, reason: 'NOT_STARTED' }
  if (now.getTime() >= c.validUntil.getTime()) return { available: false, reason: 'EXPIRED' }
  if (c.redemptionCount >= c.redemptionCap) return { available: false, reason: 'SOLD_OUT' }
  if (c.listPriceCentsSnapshot == null || c.discountAmountCents == null) return { available: false, reason: 'NOT_PUBLISHED' }
  return { available: true }
}

export interface LaunchOfferView {
  code: string
  slug: string
  offerVersion: number
  vertical: LaunchOfferVertical
  planTier: LaunchOfferPlanTier
  planName: 'Pro' | 'Premium'
  available: true
  currency: 'MXN'
  ivaIncluded: true
  requiresCard: true
  /**
   * 🔴 `ivaExact` dice si este bloque se puede pintar como «Subtotal + IVA (16 %)». Cuando es
   * `false` (el caso de $22.00) se muestra sólo el bruto con «IVA incluido»: el desglose sigue
   * viajando para la factura, pero rotularlo con el porcentaje enseñaría un centavo que no cuadra.
   */
  promo: { monthlyCents: number; months: number; subtotalCents: number; ivaCents: number; ivaExact: boolean; periodTotalCents: number }
  renewal: { monthlyCents: number; subtotalCents: number; ivaCents: number; ivaExact: boolean }
  firstChargeCents: number
  validUntil: string
  limited: true
  copy: { headline: string | null; subheadline: string | null; bullets: string[] }
}

/**
 * 🔴 La vista NO DISPONIBLE no trae UNA SOLA llave de precio, y es deliberado: una página
 * enlazada desde un anuncio viejo vive meses, y pintar ahí un precio que ya no se cobra es
 * publicidad engañosa. Cuatro llaves y ninguna más.
 */
export interface LaunchOfferUnavailableView {
  code: string
  slug: string
  available: false
  /** Abierto a propósito: lo desconocido es «no disponible» genérico, nunca un fallo. Ver el tipo. */
  unavailableReason: LaunchOfferUnavailableReasonWire
}

const PLAN_NAME: Record<LaunchOfferPlanTier, 'Pro' | 'Premium'> = { PRO: 'Pro', PREMIUM: 'Premium' }

/** Exactamente lo que ven la landing y el dashboard. Nunca expone el cupo ni el conteo (D10). */
export function buildLaunchOfferView(c: LaunchOfferCampaignRow, now: Date): LaunchOfferView | LaunchOfferUnavailableView {
  const disponible = launchOfferAvailability(c, now)
  if (!disponible.available) {
    return { code: c.code, slug: c.landingSlug, available: false, unavailableReason: disponible.reason }
  }

  // `launchOfferAvailability` ya garantizó que los dos snapshots existen (motivo NOT_PUBLISHED).
  const listPriceCents = c.listPriceCentsSnapshot as number
  const promo = splitIvaInclusive(c.advertisedPriceCents)
  const renewal = splitIvaInclusive(listPriceCents)

  return {
    code: c.code,
    slug: c.landingSlug,
    offerVersion: c.offerVersion,
    vertical: c.vertical,
    planTier: c.planTier,
    planName: PLAN_NAME[c.planTier],
    available: true,
    currency: 'MXN',
    ivaIncluded: true,
    requiresCard: true,
    promo: {
      monthlyCents: c.advertisedPriceCents,
      months: c.discountMonths,
      subtotalCents: promo.subtotalCents,
      ivaCents: promo.ivaCents,
      ivaExact: ivaBreakdownIsExact(c.advertisedPriceCents),
      periodTotalCents: promoPeriodTotalCents({ advertisedPriceCents: c.advertisedPriceCents, discountMonths: c.discountMonths }),
    },
    renewal: {
      monthlyCents: listPriceCents,
      subtotalCents: renewal.subtotalCents,
      ivaCents: renewal.ivaCents,
      ivaExact: ivaBreakdownIsExact(listPriceCents),
    },
    // 🔴 Lo que se cobra HOY es el precio promocional, nunca el de lista: con campaña SIEMPRE se
    // paga el primer ciclo (no hay prueba gratis), y ese ciclo ya lleva el cupón puesto.
    firstChargeCents: c.advertisedPriceCents,
    validUntil: c.validUntil.toISOString(),
    limited: true,
    copy: { headline: c.headline, subheadline: c.subheadline, bullets: c.bullets },
  }
}

export type StandardBillingInterval = 'monthly' | 'annual'

/** Los precios de lista CON IVA y la promoción legacy, tal como los declara planPricing.constants.ts. */
export interface StandardPlanQuote {
  grossCents: Record<LaunchOfferPlanTier, Record<StandardBillingInterval, number>>
  legacyIntro: { tier: LaunchOfferPlanTier; interval: StandardBillingInterval; introMonthlyCents: number } | null
}

/**
 * El camino SIN campaña. Con prueba gratis hoy no se cobra nada; pagando hoy se cobra el precio
 * de lista, salvo la promoción legacy (`INTRO_PRO_3M`, PRO mensual a $694.84).
 *
 * 🔴 La promoción legacy NO se derrama: sólo aplica al tier Y al intervalo que declara. Sin esa
 * comprobación, un PREMIUM anual pagaría $694.84 el primer mes.
 */
export function standardFirstChargeCents(
  quote: StandardPlanQuote,
  tier: LaunchOfferPlanTier,
  interval: StandardBillingInterval,
  payNow: boolean,
): number {
  if (!payNow) return 0
  const legacy = quote.legacyIntro
  if (legacy && legacy.tier === tier && legacy.interval === interval) return legacy.introMonthlyCents
  return quote.grossCents[tier][interval]
}
