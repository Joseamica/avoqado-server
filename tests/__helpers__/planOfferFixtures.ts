/**
 * Versiones de la oferta de planes para las pruebas (planes editables, B1).
 *
 * Se escriben a mano, sin pasar por `planOffer.ts`: así una prueba del respaldo o del cálculo del bruto no puede
 * pasar sólo porque el fixture y el código comparten el mismo error.
 */

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
}

/** Una definición guardada válida: lo de hoy (Gratis / Pro / Premium, con tarjeta, 30 días) con los cambios pedidos. */
export function definicionDePrueba(opciones: OpcionesDeLaDefinicion = {}) {
  const { ids = {}, netos = {}, nombres = {}, productos = {} } = opciones
  const precio = (ranura: Ranura) => {
    const netCents = netos[ranura] ?? NETO_DE_HOY[ranura]
    return { netCents, grossCents: bruto(netCents), stripePriceId: ids[ranura] ?? null }
  }
  const plan = (tier: 'PRO' | 'PREMIUM', nombre: string) => ({
    displayName: nombres[tier] ?? nombre,
    onSale: true,
    requiresCard: true,
    trialDays: 30,
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
