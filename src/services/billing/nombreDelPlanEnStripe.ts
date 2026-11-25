/**
 * Planes editables (B1, Task 8): el nombre del producto de Stripe de Pro y Premium.
 *
 * Una versión publicada puede renombrar un plan («Pro» → «Pro Plus»), y el nombre del producto de Stripe es lo que el cliente ve en
 * el checkout de Stripe. Tres piezas:
 * - `escribirNombreDelPlan`: **el único que escribe el nombre del producto de un plan** (el job, el intento inmediato del publicador y
 *   la sincronización del catálogo, `syncFeaturesToStripe`). Todos se forman en el mismo candado y cada uno calcula el nombre de la
 *   vigente JUSTO antes de escribir: el que llega tarde escribe lo más nuevo, así se converge en vez de deshacer un renombre.
 * - `renombrarProductosDelPlan`: lo que corre el job (`plan-offer-rename.job.ts`) cada minuto.
 * - `exigirNombreDelPlanAlDia`: la puerta del checkout de «Tu plan». Mientras Stripe diga otro nombre, 503 `PLAN_RENAME_PENDING`.
 *
 * 🔴 Reglas que no se negocian aquí:
 * 1. **`plan-offer-nombre` se toma SOLO**, nunca junto a `plan-offer-publish` ni a los candados de producto, y las llamadas a Stripe
 *    con él tomado tienen tope de 10 s.
 * 2. **Con sólo la v1 (o sin versiones) la oferta no es dueña del nombre** (`stripeProductName` nulo): la puerta no lee Stripe, el job
 *    sólo lee la base, nadie escribe `nombresEnStripe`, y la sincronización hace exactamente las llamadas a Stripe de hoy.
 * 3. **Nunca un `products.update` del nombre de un plan sin el candado**: si el candado o la lectura de la vigente fallan, no se escribe.
 *
 * Residuo declarado: una petición a Stripe abortada a los 10 s que Stripe procese después de soltar el candado. La siguiente vuelta del
 * job lo corrige y la puerta del checkout no abre mientras dure.
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import AppError from '../../errors/AppError'
import { retry, shouldRetryDbConnectionError, shouldRetryStripeError } from '../../utils/retry'
import { stripe } from '../stripe.service'
import { ofertaVigente, type OfertaVigente, type PlanPagado } from './planOffer'

/**
 * Cómo quedó el nombre de un plan:
 * - `SIN_VERSION`: la vigente no es dueña del nombre (sin versiones, la v1, o una versión que nunca lo cambió). El job no toca Stripe;
 *   la sincronización escribe el nombre del catálogo, como hoy.
 * - `AL_DIA`: Stripe ya dice el nombre de la vigente.
 * - `RENOMBRADO`: se le escribió el nombre de la vigente.
 * - `FALLO`: no se pudo (Stripe, el candado o la base); lo intenta la siguiente vuelta.
 */
export type EstadoDelNombre = 'SIN_VERSION' | 'AL_DIA' | 'RENOMBRADO' | 'FALLO'

/** El candado del nombre. Se toma SOLO: nunca con `plan-offer-publish` ni con los de producto. */
export const CANDADO_DEL_NOMBRE = 'plan-offer-nombre'

type Db = Prisma.TransactionClient | PrismaClient

const PLANES: readonly PlanPagado[] = ['PRO', 'PREMIUM']
const CODIGO_DEL_PLAN: Record<PlanPagado, 'PLAN_PRO' | 'PLAN_PREMIUM'> = { PRO: 'PLAN_PRO', PREMIUM: 'PLAN_PREMIUM' }
const PUNTERO_ID = 'vigente'

/** Bajo el candado del nombre: tope de 10 s y sin los reintentos del SDK (el job lo vuelve a intentar en un minuto). */
const STRIPE_BAJO_EL_CANDADO = { timeout: 10_000, maxNetworkRetries: 0 } as const
/**
 * La sincronización conserva TODO lo de hoy hacia Stripe (el mismo cuerpo, el mismo `retry` de 3 reintentos y los reintentos propios del
 * SDK, que mandan su `Idempotency-Key`); lo único nuevo es el tope de 10 s por petición, que no viaja a Stripe.
 */
const STRIPE_EN_LA_SINCRONIZACION = { timeout: 10_000 } as const
/** La puerta del checkout no toma ningún candado: el tope de la regla común. */
const STRIPE_EN_LA_PUERTA = { timeout: 15_000, maxNetworkRetries: 0 } as const

/** El job y el publicador: lo que dura su turno en el candado (más la espera del turno de otro). */
const TRANSACCION_DEL_JOB = { maxWait: 15_000, timeout: 30_000 } as const
/**
 * La sincronización. Su peor caso con Stripe colgado cabe en 150 s: 4 intentos de `retry` × 3 peticiones del SDK × 10 s = 120 s, más
 * las esperas entre intentos de `retry` (1 + 2 + 4 s con ±25 %: hasta 8.75 s) y las del SDK entre sus peticiones (0.5 y 1 s por
 * intento: hasta 6 s), ≈ 135 s. No cuenta un `Retry-After` de Stripe (el SDK lo respeta hasta 60 s) ni una espera larga por el
 * candado (el job lo suelta en cuanto termina sus dos llamadas de 10 s): si una de ésas lo empuja más allá, Prisma deshace la
 * transacción, se suelta el candado y la siguiente vuelta del job corrige lo que haya quedado. Mientras tanto, el job y el publicador
 * esperan su turno o lo intentan en la siguiente vuelta.
 */
const TRANSACCION_DE_LA_SINCRONIZACION = { maxWait: 15_000, timeout: 150_000 } as const

const MENSAJE_RENOMBRE_PENDIENTE = 'Estamos actualizando el nombre de tu plan. Intenta en un minuto. No se te cobró nada.'

/** Lo que se guarda por plan en `PlanOfferPointer.nombresEnStripe` (para mostrarlo), sólo cuando cambió. */
export interface ObservacionDelNombre {
  esperado: string
  enStripe: string | null
  estado: EstadoDelNombre
}

/** El nombre que la vigente le pide al producto de ese plan; `null` = no es dueña del nombre (sin versiones o la v1). */
function nombrePropio(vigente: OfertaVigente, tier: PlanPagado): string | null {
  return vigente.respaldo ? null : vigente.definition[tier].stripeProductName
}

async function productoDelPlan(db: Db, tier: PlanPagado): Promise<string | null> {
  const fila = await db.feature.findUnique({ where: { code: CODIGO_DEL_PLAN[tier] }, select: { stripeProductId: true } })
  return fila?.stripeProductId ?? null
}

const comoTexto = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Escribe la observación del plan sólo si cambió (todos los escritores la tocan con el candado del nombre tomado). `enStripe`
 * `undefined` = Stripe no se pudo leer: se conserva lo último que se observó.
 */
async function anotarObservacion(
  tx: Prisma.TransactionClient,
  tier: PlanPagado,
  esperado: string,
  estado: EstadoDelNombre,
  enStripe: string | null | undefined,
): Promise<void> {
  const puntero = await tx.planOfferPointer.findUnique({ where: { id: PUNTERO_ID }, select: { nombresEnStripe: true } })
  if (!puntero) return
  const valor = puntero.nombresEnStripe
  const guardadas = (valor && typeof valor === 'object' && !Array.isArray(valor) ? valor : {}) as unknown as Record<
    string,
    ObservacionDelNombre | undefined
  >
  const antes = guardadas[tier]
  const nueva: ObservacionDelNombre = { esperado, enStripe: enStripe === undefined ? (antes?.enStripe ?? null) : enStripe, estado }
  if (antes && antes.esperado === nueva.esperado && antes.enStripe === nueva.enStripe && antes.estado === nueva.estado) return
  await tx.planOfferPointer.update({
    where: { id: PUNTERO_ID },
    data: { nombresEnStripe: { ...guardadas, [tier]: nueva } as unknown as Prisma.InputJsonValue },
  })
}

/**
 * Escribe el nombre del producto de Stripe del plan. 🔴 Toma `plan-offer-nombre` y DESPUÉS lee la vigente con esa transacción.
 *
 * - `JOB` (el job y el intento inmediato del publicador): sin nombre propio → `SIN_VERSION` sin tocar Stripe. Con él, lee el producto
 *   y, si dice otro, `products.update(productId, { name })` (la respuesta ya trae el nombre: no se relee). Nunca lanza: `FALLO`.
 * - `SYNC` (`syncFeaturesToStripe`): el `products.update(productId, { name, description })` de hoy, directo, con el mismo `retry`,
 *   sobre el mismo producto que la sincronización (`catalogo.productId`) y sin leer antes ni después. El nombre es el de la vigente o,
 *   sin nombre propio, el del catálogo (`catalogo.nombre`). Si Stripe lo rechaza, el error sube tal cual (la sincronización salta el
 *   precio de ese plan, como hoy). Si el candado o la lectura fallan, `FALLO` con aviso y sin escribir ningún nombre.
 *
 * Si Stripe ya tiene el nombre y lo que falla después es la observación o el commit, se avisa así («ya se escribió en Stripe») y se
 * devuelve lo que se escribió, no `FALLO`.
 *
 * Sin llave de idempotencia: poner un nombre es repetible.
 */
export async function escribirNombreDelPlan(
  tier: PlanPagado,
  origen: 'JOB' | 'SYNC',
  catalogo?: { nombre: string; descripcion: string | null; productId: string },
): Promise<EstadoDelNombre> {
  if (origen === 'SYNC' && !catalogo) throw new Error('escribirNombreDelPlan: la sincronización necesita el nombre del catálogo')
  /**
   * Lo que pasó dentro de la transacción, para el `catch` de afuera (en un objeto: el análisis de flujo no ve lo que una función
   * interna le asigna a una variable).
   * - `rechazoDeStripe`: el error de Stripe de la sincronización; ése sube tal cual, los demás (candado, base) son `FALLO`.
   * - `escritoEnStripe`: lo que ya quedó en Stripe (un `products.update` que contestó); `null` = no se escribió nada.
   */
  const marca: { rechazoDeStripe: unknown; escritoEnStripe: EstadoDelNombre | null } = { rechazoDeStripe: undefined, escritoEnStripe: null }
  try {
    return await prisma.$transaction(
      async (tx): Promise<EstadoDelNombre> => {
        // 🔴 Primero el candado; la vigente se lee DESPUÉS y con esta transacción.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${CANDADO_DEL_NOMBRE}))`
        const vigente = await ofertaVigente(tx)
        const propio = nombrePropio(vigente, tier)
        if (!propio && origen === 'JOB') return 'SIN_VERSION'

        if (origen === 'SYNC') {
          const {
            nombre: delCatalogo,
            descripcion,
            productId,
          } = catalogo as { nombre: string; descripcion: string | null; productId: string }
          let actualizado: { name?: string | null } | undefined
          try {
            actualizado = await retry(
              () =>
                stripe.products.update(
                  productId,
                  { name: propio ?? delCatalogo, description: descripcion || undefined },
                  STRIPE_EN_LA_SINCRONIZACION,
                ),
              { retries: 3, shouldRetry: shouldRetryStripeError, context: 'stripe.updateProduct' },
            )
          } catch (error) {
            marca.rechazoDeStripe = error
            throw error
          }
          // Sin nombre propio es el nombre del catálogo, como hoy: nadie anota la observación.
          const escrito: EstadoDelNombre = propio ? 'RENOMBRADO' : 'SIN_VERSION'
          marca.escritoEnStripe = escrito
          if (propio) await anotarObservacion(tx, tier, propio, 'RENOMBRADO', actualizado?.name ?? null)
          return escrito
        }

        // JOB, con la vigente dueña del nombre: su producto se lee de la base.
        const productId = await productoDelPlan(tx, tier)
        if (!productId) {
          logger.error('🚨 nombreDelPlanEnStripe: el plan no tiene producto de Stripe — no se escribe su nombre', { tier, origen })
          return 'FALLO'
        }
        const esperado = propio as string
        /** `undefined` mientras Stripe no se haya podido leer. */
        let enStripe: string | null | undefined
        let estado: EstadoDelNombre
        try {
          enStripe = (await stripe.products.retrieve(productId, STRIPE_BAJO_EL_CANDADO)).name ?? null
          estado = 'AL_DIA'
          if (enStripe !== esperado) {
            enStripe = (await stripe.products.update(productId, { name: esperado }, STRIPE_BAJO_EL_CANDADO)).name ?? null
            estado = enStripe === esperado ? 'RENOMBRADO' : 'FALLO'
            marca.escritoEnStripe = estado
          }
        } catch (error) {
          logger.warn('Renombre de los planes: Stripe no contestó el nombre del plan', { tier, error: comoTexto(error) })
          estado = 'FALLO'
        }
        await anotarObservacion(tx, tier, esperado, estado, enStripe)
        return estado
      },
      origen === 'SYNC' ? TRANSACCION_DE_LA_SINCRONIZACION : TRANSACCION_DEL_JOB,
    )
  } catch (error) {
    if (origen === 'SYNC' && marca.rechazoDeStripe !== undefined && error === marca.rechazoDeStripe) throw error
    if (marca.escritoEnStripe !== null) {
      // Stripe ya tiene el nombre; lo que falló después fue la observación o el commit (la siguiente vuelta la vuelve a anotar).
      logger.warn('Renombre de los planes: el nombre ya se escribió en Stripe; no se guardó la observación', {
        tier,
        origen,
        error: comoTexto(error),
      })
      return marca.escritoEnStripe
    }
    // El candado no llegó a tiempo, la base no contestó o la vigente está rota: no se escribió ningún nombre.
    logger.warn('Renombre de los planes: no se pudo tomar el candado del nombre o leer la vigente — no se escribe el nombre', {
      tier,
      origen,
      error: comoTexto(error),
    })
    return 'FALLO'
  }
}

/**
 * Lo que corre el job: `escribirNombreDelPlan(tier, 'JOB')` por cada plan que la vigente nombra. La revisión previa (fuera de toda
 * transacción, con reintento de conexión) evita tomar el candado cada minuto cuando la oferta no es dueña de ningún nombre.
 */
export async function renombrarProductosDelPlan(): Promise<Record<PlanPagado, EstadoDelNombre>> {
  const vigente = await retry(() => ofertaVigente(), {
    retries: 2,
    initialDelay: 1500,
    shouldRetry: shouldRetryDbConnectionError,
    context: 'plan-offer-rename.vigente',
  })
  const resultado: Record<PlanPagado, EstadoDelNombre> = { PRO: 'SIN_VERSION', PREMIUM: 'SIN_VERSION' }
  for (const tier of PLANES) {
    if (!nombrePropio(vigente, tier)) continue
    resultado[tier] = await escribirNombreDelPlan(tier, 'JOB')
  }
  return resultado
}

const renombrePendiente = (tier: PlanPagado) => new AppError(MENSAJE_RENOMBRE_PENDIENTE, 503, true, 'PLAN_RENAME_PENDING', { tier })

/**
 * La puerta del checkout de «Tu plan». Sin versiones, con la v1 o con un plan que la oferta nunca renombró: no hace nada (ni lee
 * Stripe). Si la vigente es dueña del nombre, lee el producto EN VIVO (no confía en una marca guardada) y, si Stripe dice otro nombre
 * o no contesta, 503 `PLAN_RENAME_PENDING`. Se llama una sola vez, ANTES de la regla común: dentro, vencería el enlace abierto de
 * otra pestaña.
 *
 * Residuo aceptado (los nombres no son dinero): una petición que ya pasó la puerta cuando se publica un nombre nuevo, o la ventana de
 * hasta ~1 minuto hasta que el job converge, puede abrir una sesión con el nombre anterior.
 */
export async function exigirNombreDelPlanAlDia(tier: PlanPagado): Promise<void> {
  const vigente = await ofertaVigente()
  const esperado = nombrePropio(vigente, tier)
  if (!esperado) return
  const productId = await productoDelPlan(prisma, tier)
  if (!productId) {
    logger.error('🚨 nombreDelPlanEnStripe: el plan no tiene producto de Stripe — no se abre el checkout', { tier })
    throw new AppError(
      'Los planes no están disponibles por un problema nuestro de configuración. No se cobró nada.',
      503,
      true,
      'PLAN_NOT_CONFIGURED',
      { tier },
    )
  }
  let enStripe: string | null
  try {
    enStripe = (await stripe.products.retrieve(productId, STRIPE_EN_LA_PUERTA)).name ?? null
  } catch (error) {
    logger.warn('Renombre de los planes: la puerta del checkout no pudo leer el nombre en Stripe', { tier, error: comoTexto(error) })
    throw renombrePendiente(tier)
  }
  if (enStripe !== esperado) {
    logger.warn('Renombre de los planes: Stripe todavía dice otro nombre — el checkout espera', { tier, esperado, enStripe })
    throw renombrePendiente(tier)
  }
}
