import type Stripe from 'stripe'
import AppError from '../../errors/AppError'
import logger from '../../config/logger'
import { stripe, STRIPE_DENTRO_DEL_CANDADO, planLookupKey, stripeAfirmaQueNoExiste, type PlanTierCode } from '../stripe.service'
import { MENSAJE_PLAN_NO_CONFIGURADO, precioDeLaOferta, versionQueCobra, type PlanPagado } from './planOffer'
import { ofertaCambio } from './opcionesDeCompra'

export { MENSAJE_PLAN_NO_CONFIGURADO }

/**
 * Codex b2-code r5 A: la relectura de la oferta de `resolverPrecioDelPlan` falló (CUALQUIER error: la definición ilegible, un error
 * crudo de Prisma, un corte de conexión), marcado en su origen. Es el 503 `PLAN_NOT_CONFIGURED` reintentable de «plan no
 * configurado»; la causa queda en `cause` (no enumerable, para el log). Sólo lo pide el alta larga (`marcarLaLecturaFallida`), cuyo
 * `catch` lo deja salir en vez de terminar el alta en Gratis.
 */
export class LecturaDeLaOfertaFallida extends AppError {
  constructor(causa: unknown) {
    super(MENSAJE_PLAN_NO_CONFIGURADO, 503, true, 'PLAN_NOT_CONFIGURED')
    // El objetivo es es2020: `super(message, { cause })` no compila (el patrón de `serializableRetry.ts`).
    Object.defineProperty(this, 'cause', { value: causa, enumerable: false, writable: true, configurable: true })
  }
}

/**
 * B0, tal cual: el precio de Stripe de un plan por su LLAVE (`plan_pro_monthly`…). Sin precio: el 503 `PLAN_NOT_CONFIGURED`
 * del alta. Es el camino de hoy sin versiones o con sólo la v1, y la relectura de quien verificó por la llave.
 */
export async function resolverPrecioPorLlave(
  tierCode: PlanTierCode,
  interval: 'monthly' | 'annual',
): Promise<{ priceId: string; unitAmount: number }> {
  const lookupKey = planLookupKey(tierCode, interval)
  // 🔴 Corre bajo el candado de la regla común (Codex C3): tiempo propio y sin reintentos del SDK.
  const prices = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 }, STRIPE_DENTRO_DEL_CANDADO)
  const price = prices.data[0]
  if (!price) {
    logger.error('🚨 resolverPrecioDelPlan: no hay precio de Stripe para la llave — NO se cobra', { lookupKey, tierCode })
    throw new AppError(MENSAJE_PLAN_NO_CONFIGURADO, 503, true, 'PLAN_NOT_CONFIGURED', { tierCode })
  }
  return { priceId: price.id, unitAmount: price.unit_amount ?? 0 }
}

function noConfigurado(registro: Record<string, unknown>, tierCode?: unknown): AppError {
  // 🚨 a propósito: la versión vigente apunta a un precio de Stripe que no sirve para cobrar.
  logger.error('🚨 el precio de Stripe de la versión no está disponible o no coincide — NO se cobra', registro)
  return new AppError(MENSAJE_PLAN_NO_CONFIGURADO, 503, true, 'PLAN_NOT_CONFIGURED', { tierCode: tierCode ?? registro.tierCode })
}

/**
 * Lee un precio de Stripe por su id y exige que sirva para cobrar: `active` y del bruto esperado. 404, inactivo u otro monto →
 * 503 `PLAN_NOT_CONFIGURED` (falla cerrado, con el 🚨 de siempre); otro error de Stripe (tiempo agotado, 5xx) sube tal cual.
 * Bajo el candado de la regla común: tiempo propio y sin reintentos del SDK. `contexto` sólo alimenta el log.
 */
export async function exigirPrecioDeStripe(
  priceId: string,
  grossCents: number,
  contexto: Record<string, unknown> = {},
): Promise<{ priceId: string; unitAmount: number }> {
  const falla = (motivo: string, stripeAmount: number | null) =>
    noConfigurado({ ...contexto, priceId, esperado: grossCents, stripe: stripeAmount, motivo })
  let price: Stripe.Price
  try {
    price = await stripe.prices.retrieve(priceId, STRIPE_DENTRO_DEL_CANDADO)
  } catch (error) {
    if (stripeAfirmaQueNoExiste(error)) throw falla('NO_EXISTE', null)
    throw error
  }
  if (!price.active) throw falla('INACTIVO', price.unit_amount ?? null)
  if (price.unit_amount !== grossCents) throw falla('OTRO_MONTO', price.unit_amount ?? null)
  return { priceId, unitAmount: grossCents }
}

/**
 * Resuelve UNA vez el precio de Stripe de un plan para que quien cobra lo haga con ese `priceId` y no lo vuelva a buscar.
 *
 * - **Sin una versión publicada por el editor** (tablas vacías o sólo la v1, que es una foto de lo de hoy): por la llave,
 *   exactamente como B0 (`resolverPrecioPorLlave`).
 * - **Con ella** (`versionQueCobra()`): el `priceId` de su ranura, leído con `prices.retrieve`. Se exige `active` y que el
 *   monto sea el bruto de la versión; si no, o si Stripe dice que no existe (404), 503 `PLAN_NOT_CONFIGURED`: no se cobra
 *   un precio que no es el publicado. Otro error de Stripe (tiempo agotado, 5xx) sube tal cual, como el de la llave.
 *
 * `soloSinVersionDelEditor` (Codex b2-code #1): lo piden los carriles que cobran SIN versión del editor (el alta larga y el
 * checkout de «Tu plan» sin comprobante), que ya leyeron la compuerta. Si esta relectura ve una versión del editor (se publicó en
 * medio), 409 `OFFER_CHANGED` reason `VERSION` con su número, sin leer ningún precio de Stripe: ese carril no cobra con la versión
 * nueva sin su comprobante. Sin versión del editor, la llave de B0, igual.
 *
 * `marcarLaLecturaFallida` (Codex b2-code r5 A): si esa relectura lanza, sale como `LecturaDeLaOfertaFallida`. Sin la opción, el
 * error sube tal cual (el checkout, como hoy).
 */
export async function resolverPrecioDelPlan(
  tierCode: PlanTierCode,
  interval: 'monthly' | 'annual',
  opciones: { soloSinVersionDelEditor?: boolean; marcarLaLecturaFallida?: boolean } = {},
): Promise<{ priceId: string; unitAmount: number }> {
  let version: Awaited<ReturnType<typeof versionQueCobra>>
  try {
    version = await versionQueCobra()
  } catch (error) {
    if (opciones.marcarLaLecturaFallida) throw new LecturaDeLaOfertaFallida(error)
    throw error
  }
  if (!version) return resolverPrecioPorLlave(tierCode, interval)
  if (opciones.soloSinVersionDelEditor) throw ofertaCambio('VERSION', version.number)

  const tier: PlanPagado = tierCode === 'PLAN_PREMIUM' ? 'PREMIUM' : 'PRO'
  const ranura = precioDeLaOferta(version.definition, tier, interval)
  const contexto = { tierCode, interval, versionId: version.versionId, number: version.number }
  if (!ranura.stripePriceId)
    throw noConfigurado({ ...contexto, priceId: null, esperado: ranura.grossCents, stripe: null, motivo: 'SIN_PRECIO' }, tierCode)
  return exigirPrecioDeStripe(ranura.stripePriceId, ranura.grossCents, contexto)
}
