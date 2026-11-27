/**
 * Planes editables (B1, Task 8): el nombre del producto de Stripe de Pro y Premium.
 *
 * Una versión publicada puede renombrar un plan («Pro» → «Pro Plus»), y el nombre del producto de Stripe es lo que el cliente ve en
 * el checkout de Stripe. Tres piezas:
 * - `escribirNombreDelPlan`: escribe el nombre del producto de un plan para el job, el intento inmediato del publicador y la
 *   sincronización del catálogo (`syncFeaturesToStripe`). Cuando la vigente es dueña del nombre, se escribe bajo el candado y con el
 *   nombre calculado JUSTO antes de escribir: el que llega tarde escribe lo más nuevo, así se converge en vez de deshacer un renombre.
 * - `renombrarProductosDelPlan`: lo que corre el job (`plan-offer-rename.job.ts`) cada minuto.
 * - `exigirNombreDelPlanAlDia`: la puerta del checkout de «Tu plan». Mientras Stripe diga otro nombre, 503 `PLAN_RENAME_PENDING`.
 *
 * 🔴 Reglas que no se negocian aquí:
 * 1. **`plan-offer-nombre` se toma SOLO**, nunca junto a `plan-offer-publish` ni a los candados de producto, y las llamadas a Stripe
 *    con él tomado tienen tope de 10 s por petición.
 * 2. **Con sólo la v1 (o sin versiones) la oferta no es dueña del nombre** (`stripeProductName` nulo): la puerta no lee Stripe, el job
 *    sólo lee la base, nadie escribe `nombresEnStripe`, y la sincronización hace hacia Stripe exactamente lo de B0 (mismos argumentos,
 *    sin opciones de petición, mismo orden y mismas veces). Lo único extra son lecturas de la base.
 * 3. **El nombre de una vigente dueña de él sólo se escribe bajo el candado.** La sincronización escribe el del catálogo sin candado
 *    (es B0) cuando la vigente no es dueña del nombre o cuando no se pudo saber (falló el candado o la lectura); después lo revisa bajo
 *    el candado y, si para entonces la vigente es dueña de otro nombre, lo escribe (Codex B1 #3).
 *
 * Residuos declarados (la puerta del checkout no abre mientras duren; el job los corrige en su siguiente vuelta, ~1 min):
 * - una petición a Stripe abortada a los 10 s que Stripe procese después de soltar el candado;
 * - el nombre del catálogo que la sincronización escribe sin candado (B0) queda encima de un renombre publicado porque su revisión
 *   posterior no lo pudo corregir (falló, o Stripe procesó el update de B0 después de la revisión).
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import AppError from '../../errors/AppError'
import { retry, shouldRetryDbConnectionError, shouldRetryStripeError } from '../../utils/retry'
import { stripe } from '../stripe.service'
import { numeroDeLaVigente, ofertaVigente, type OfertaVigente, type PlanPagado } from './planOffer'

/**
 * Cómo quedó el nombre de un plan:
 * - `SIN_VERSION`: la vigente no es dueña del nombre (sin versiones, la v1, o una versión que nunca lo cambió). El job no toca Stripe;
 *   la sincronización escribió el nombre del catálogo, como B0 (también cuando no pudo saber de quién es el nombre).
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
 * Sólo el paso 2 de la sincronización (la vigente es dueña del nombre, lo que exige una versión del editor): el mismo cuerpo y el mismo
 * `retry` que el resto de la sincronización, con los reintentos propios del SDK, y un tope de 10 s por petición porque va bajo el
 * candado. El nombre del catálogo (paso 3, lo de B0) NO lleva opciones de petición.
 */
const STRIPE_NOMBRE_PROPIO_EN_LA_SINCRONIZACION = { timeout: 10_000 } as const
/** La puerta del checkout no toma ningún candado: el tope de la regla común. */
const STRIPE_EN_LA_PUERTA = { timeout: 15_000, maxNetworkRetries: 0 } as const

/** El job, el publicador y la revisión posterior de la sincronización: su turno en el candado (más la espera del turno de otro). */
const TRANSACCION_DEL_JOB = { maxWait: 15_000, timeout: 30_000 } as const
/**
 * Los pasos 1 y 2 de la sincronización (decidir y, si la vigente es dueña del nombre, escribirlo). Sin nombre propio dura el candado y
 * una lectura. Con él, el tope lo pone el paso 2 con Stripe colgado: 4 intentos de `retry` × 3 peticiones del SDK × 10 s = 120 s, más
 * las esperas entre intentos de `retry` (1 + 2 + 4 s con ±25 %: hasta 8.75 s) y las del SDK entre sus peticiones (0.5 y 1 s por
 * intento: hasta 6 s), ≈ 135 s. No cuenta un `Retry-After` de Stripe (el SDK lo respeta hasta 60 s) ni una espera larga por el
 * candado: si una de ésas lo empuja más allá, Prisma deshace la transacción, se suelta el candado y la siguiente vuelta del job corrige
 * lo que haya quedado.
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
 * Escribe el nombre del producto de Stripe del plan.
 *
 * - `JOB` (el job, el intento inmediato del publicador y la revisión posterior de la sincronización): toma `plan-offer-nombre` y
 *   DESPUÉS lee la vigente con esa transacción. Sin nombre propio → `SIN_VERSION` sin tocar Stripe. Con él, lee el producto y, si dice
 *   otro, `products.update(productId, { name })` (la respuesta ya trae el nombre: no se relee), con el tope de 10 s y sin los
 *   reintentos del SDK. Nunca lanza: `FALLO`.
 * - `SYNC` (`syncFeaturesToStripe`): ver `escribirEnLaSincronizacion`.
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
  if (origen === 'SYNC') {
    if (!catalogo) throw new Error('escribirNombreDelPlan: la sincronización necesita el nombre del catálogo')
    return escribirEnLaSincronizacion(tier, catalogo)
  }
  /** `escritoEnStripe`: lo que ya quedó en Stripe (un `products.update` que contestó); `null` = no se escribió nada. */
  const marca: { escritoEnStripe: EstadoDelNombre | null } = { escritoEnStripe: null }
  try {
    return await prisma.$transaction(async (tx): Promise<EstadoDelNombre> => {
      // 🔴 Primero el candado; la vigente se lee DESPUÉS y con esta transacción.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${CANDADO_DEL_NOMBRE}))`
      const propio = nombrePropio(await ofertaVigente(tx), tier)
      if (!propio) return 'SIN_VERSION'

      // La vigente es dueña del nombre: su producto se lee de la base.
      const productId = await productoDelPlan(tx, tier)
      if (!productId) {
        logger.error('🚨 nombreDelPlanEnStripe: el plan no tiene producto de Stripe — no se escribe su nombre', { tier, origen })
        return 'FALLO'
      }
      /** `undefined` mientras Stripe no se haya podido leer. */
      let enStripe: string | null | undefined
      let estado: EstadoDelNombre
      try {
        enStripe = (await stripe.products.retrieve(productId, STRIPE_BAJO_EL_CANDADO)).name ?? null
        estado = 'AL_DIA'
        if (enStripe !== propio) {
          enStripe = (await stripe.products.update(productId, { name: propio }, STRIPE_BAJO_EL_CANDADO)).name ?? null
          estado = enStripe === propio ? 'RENOMBRADO' : 'FALLO'
          marca.escritoEnStripe = estado
        }
      } catch (error) {
        logger.warn('Renombre de los planes: Stripe no contestó el nombre del plan', { tier, error: comoTexto(error) })
        estado = 'FALLO'
      }
      await anotarObservacion(tx, tier, propio, estado, enStripe)
      return estado
    }, TRANSACCION_DEL_JOB)
  } catch (error) {
    if (marca.escritoEnStripe !== null) {
      avisarYaEscrito(tier, origen, error)
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

/** Stripe ya tiene el nombre; lo que falló después fue la observación o el commit (la siguiente vuelta la vuelve a anotar). */
function avisarYaEscrito(tier: PlanPagado, origen: 'JOB' | 'SYNC', error: unknown): void {
  logger.warn('Renombre de los planes: el nombre ya se escribió en Stripe; no se guardó la observación', {
    tier,
    origen,
    error: comoTexto(error),
  })
}

/**
 * La sincronización del catálogo (`syncFeaturesToStripe`) sobre el producto de un plan (Codex B1 #3). Con el interruptor apagado (sin
 * versiones o con sólo la v1), hacia Stripe es B0 byte a byte; lo único extra son lecturas de la base.
 *
 * 1. **Decidir:** toma `plan-offer-nombre` y lee la vigente con esa transacción. Si el candado o la lectura fallan, el nombre de la
 *    oferta queda DESCONOCIDO (con aviso).
 * 2. **Si la vigente es dueña del nombre** (sólo existe con una versión del editor): en la misma transacción, con el candado tomado,
 *    `products.update(productId, { name: <el de la vigente>, description })` con el mismo `retry` y el tope de 10 s por petición. Si
 *    Stripe lo rechaza, el error sube tal cual (la sincronización salta el precio de ese plan, como B0) y no hay revisión. Si se cae la
 *    transacción antes de escribir, `FALLO` sin escribir nada (sin candado nunca se escribe el nombre de una vigente dueña de él).
 * 3. **Si no hay nombre de la oferta (nulo o desconocido):** exactamente lo de B0, fuera de toda transacción:
 *    `products.update(productId, { name: <el del catálogo>, description })` con el mismo `retry` y SIN opciones de petición. Si falla,
 *    el error sube tal cual (la sincronización salta el precio de ese plan, como B0).
 * 4. **Revisión posterior** (sólo si el paso 3 escribió): una vuelta del job para este plan (`escribirNombreDelPlan(tier, 'JOB')`). Si
 *    la vigente AHORA es dueña del nombre (se publicó una versión a media escritura), lo escribe bajo el candado con el tope de 10 s y
 *    converge sin esperar al job. Nunca lanza: si falla deja su aviso, el job lo corrige en su siguiente vuelta y la puerta del
 *    checkout no abre mientras tanto. Sin nombre propio sólo es el candado y una lectura: no toca Stripe.
 *
 * Devuelve `RENOMBRADO`/`AL_DIA` si quedó el nombre de la vigente (paso 2 o la revisión), `SIN_VERSION` si quedó el del catálogo y
 * `FALLO` sólo en el caso del paso 2 que no escribió.
 */
async function escribirEnLaSincronizacion(
  tier: PlanPagado,
  catalogo: { nombre: string; descripcion: string | null; productId: string },
): Promise<EstadoDelNombre> {
  const { nombre, descripcion, productId } = catalogo
  /**
   * Lo que pasó dentro de la transacción, para el `catch` de afuera (en un objeto: el análisis de flujo no ve lo que una función
   * interna le asigna a una variable).
   * - `propio`: el nombre de la vigente leído bajo el candado; `null` = no es dueña; `undefined` = no se llegó a leer (desconocido).
   * - `rechazoDeStripe`: el error de Stripe del paso 2; ése sube tal cual.
   * - `escritoEnStripe`: lo que ya quedó en Stripe en el paso 2; `null` = nada.
   */
  const marca: { propio: string | null | undefined; rechazoDeStripe: unknown; escritoEnStripe: EstadoDelNombre | null } = {
    propio: undefined,
    rechazoDeStripe: undefined,
    escritoEnStripe: null,
  }
  try {
    const escrito = await prisma.$transaction(async (tx): Promise<EstadoDelNombre | null> => {
      // Paso 1. 🔴 Primero el candado; la vigente se lee DESPUÉS y con esta transacción.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${CANDADO_DEL_NOMBRE}))`
      const propio = nombrePropio(await ofertaVigente(tx), tier)
      marca.propio = propio
      // Con cualquier versión del editor (≥ 2) el nombre se escribe SIEMPRE bajo el candado, aunque esa versión conservó el del
      // catálogo (`stripeProductName: null`): sin candado, ese update podría deshacer un renombre en carrera. Con la v1 o sin
      // versiones, `return null`: el paso 3 de B0 tal cual.
      const delCatalogo = !propio
      if (delCatalogo) {
        let numero: number | null
        try {
          numero = await numeroDeLaVigente(tx)
        } catch (error) {
          // Sin el número no se sabe si hay una versión del editor: lo de hoy (el paso 3 de B0), pero dicho.
          logger.warn(
            'Renombre de los planes: no se pudo leer el número de la vigente — se escribe el nombre del catálogo, como antes de los planes editables',
            { tier, error: comoTexto(error) },
          )
          throw error
        }
        if (numero === null || numero < 2) return null
      }
      const nombreAEscribir = propio ?? nombre

      // Paso 2: bajo el candado, el nombre de la vigente (o el del catálogo) con la descripción del catálogo.
      let actualizado: { name?: string | null } | undefined
      try {
        actualizado = await retry(
          () =>
            stripe.products.update(
              productId,
              { name: nombreAEscribir, description: descripcion || undefined },
              STRIPE_NOMBRE_PROPIO_EN_LA_SINCRONIZACION,
            ),
          { retries: 3, shouldRetry: shouldRetryStripeError, context: 'stripe.updateProduct' },
        )
      } catch (error) {
        marca.rechazoDeStripe = error
        throw error
      }
      if (!propio) {
        // El nombre del catálogo quedó escrito bajo el candado: no hay nombre propio que anotar ni revisar después.
        marca.escritoEnStripe = 'SIN_VERSION'
        return 'SIN_VERSION'
      }
      marca.escritoEnStripe = 'RENOMBRADO'
      await anotarObservacion(tx, tier, propio, 'RENOMBRADO', actualizado?.name ?? null)
      return 'RENOMBRADO'
    }, TRANSACCION_DE_LA_SINCRONIZACION)
    if (escrito) return escrito
  } catch (error) {
    if (marca.rechazoDeStripe !== undefined && error === marca.rechazoDeStripe) throw error
    if (marca.escritoEnStripe !== null) {
      avisarYaEscrito(tier, 'SYNC', error)
      return marca.escritoEnStripe
    }
    if (marca.propio) {
      // La vigente es dueña del nombre y la transacción se cayó antes de escribirlo: sin candado no se escribe (lo hace el job).
      logger.warn('Renombre de los planes: la sincronización no pudo escribir el nombre de la vigente — lo escribe el job', {
        tier,
        error: comoTexto(error),
      })
      return 'FALLO'
    }
    // `null`: la vigente no es dueña del nombre y sólo falló el commit de la lectura; nada que avisar. `undefined`: desconocido.
    if (marca.propio === undefined)
      logger.warn(
        'Renombre de los planes: no se pudo tomar el candado del nombre o leer la vigente — se escribe el nombre del catálogo, como antes de los planes editables',
        { tier, error: comoTexto(error) },
      )
  }

  // Paso 3: lo de B0, tal cual (sin transacción, sin candado y sin opciones de petición). Si falla, sube.
  await retry(
    () =>
      stripe.products.update(productId, {
        name: nombre,
        description: descripcion || undefined,
      }),
    {
      retries: 3,
      shouldRetry: shouldRetryStripeError,
      context: 'stripe.updateProduct',
    },
  )

  // Paso 4: si en medio se publicó un nombre, se escribe ahora bajo el candado (sin nombre propio no toca Stripe).
  const revision = await escribirNombreDelPlan(tier, 'JOB')
  return revision === 'RENOMBRADO' || revision === 'AL_DIA' ? revision : 'SIN_VERSION'
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
