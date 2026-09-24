/**
 * La regla común de compra (diseño v5.1, V5-A paso 4, 22-sep-2026).
 *
 * TODO camino que abre una confirmación de pago (checkout de plan, checkout de función, cambio de plan) pasa por aquí
 * antes de crearla. Bajo un candado POR NEGOCIO (sin espera, sin Redis):
 *   0. si el alta del negocio está cobrando, no se abre nada;
 *   1. se expiran las confirmaciones abiertas NUESTRAS del cliente (también las legacy de plan) — si una ya se completó,
 *      no se abre otra: su entrega la resuelve;
 *   2. se lee lo que el negocio tiene VIVO en Stripe (no el acceso local);
 *   3. se evalúa la compatibilidad (un plan, sin sueltas absorbidas, sin duplicadas, sin desconocidas);
 *   4. sólo entonces se crea, y lo creado se devuelve DESPUÉS de confirmar (una transacción abortada nunca lo publica).
 */
import AppError from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import { stripe, STRIPE_DENTRO_DEL_CANDADO } from '@/services/stripe.service'
import { elPlanConcede } from './basePlan.service'
import { avisarConflictoCreado, registrarConflictoDeObligacion } from './conflictosDeObligacion.service'
import { inventarioDeObligaciones } from './inventarioDeObligaciones'
import { evaluarCompatibilidad, type CodigoDeIncompatibilidad, type Intencion } from './obligacionesDeCobro'

const STRIPE = STRIPE_DENTRO_DEL_CANDADO

/**
 * 🔴 Codex C3: nada de lo que corre bajo el candado puede sobrevivir a su transacción. Cada llamada a Stripe tiene 15 s y
 * ningún reintento del SDK; las LECTURAS (confirmaciones abiertas + inventario) tienen este presupuesto y, si se agota, no
 * se crea nada (503, ningún dinero se movió); y la transacción dura más que el peor caso de lecturas + creación.
 */
const PRESUPUESTO_LECTURAS_MS = 45_000
const TIMEOUT_DE_LA_TRANSACCION_MS = 150_000

/**
 * Cuánto puede estar EN VUELO el cobro del carril viejo del alta: la marca temprana (`OnboardingProgress.completedAt`)
 * la pone la misma petición que cobra, y ninguna petición vive 15 min. Pasado eso, una marca sin la de la organización es
 * un alta que se quedó a medias (Berthe, 8-dic-2025, la única en producción al 22-sep), no un cobro en curso: lo que
 * protege entonces es el inventario de Stripe, que ve la suscripción si el cobro ocurrió.
 */
const VENTANA_DEL_ALTA_MS = 15 * 60_000

const MENSAJES: Record<CodigoDeIncompatibilidad, string> = {
  OBLIGACION_DESCONOCIDA: 'Este negocio tiene un cobro en Stripe que no reconocemos. Lo revisamos y te avisamos.',
  PLAN_YA_CONTRATADO:
    'Este negocio ya tiene un plan que Stripe sigue cobrando (aunque esté suspendido). Para cambiarlo, usa el cambio de plan.',
  PLAN_ABSORBE_SUELTA: 'Ese plan incluye una función que ya pagas por separado. Escríbenos para hacer el cambio sin cobrarte dos veces.',
  FUNCION_YA_CONTRATADA: 'Esa función ya está contratada.',
  INCLUIDA_EN_EL_PLAN: 'Esa función ya viene incluida en tu plan.',
  OTRO_PLAN_VIVO: 'Este negocio tiene más de un plan cobrando. Lo revisamos y te avisamos.',
  SIN_PLAN_QUE_CAMBIAR: 'No encontramos un plan vigente que cambiar.',
  CAMBIO_AMBIGUO: 'Tu suscripción tiene una forma que no podemos cambiar automáticamente. Escríbenos.',
  OBLIGACIONES_INCOMPATIBLES: 'Este negocio tiene cobros que se enciman. Lo revisamos antes de abrir otro.',
}

/** ¿Es una confirmación de pago NUESTRA? Las nuevas llevan `kind`; las de plan anteriores, `tierCode`. */
const esNuestra = (metadata: Record<string, string> | null | undefined) =>
  Boolean(metadata && (metadata.kind === 'PLAN_CHECKOUT' || metadata.kind === 'FEATURE_PURCHASE' || metadata.tierCode))

type Resultado<T> = { creado: T; auditar: string[] } | { rechazo: AppError; auditar: string[] }

export async function autorizarObligacionNueva<T>(
  venueId: string,
  customerId: string,
  intencion: Intencion,
  crear: () => Promise<T>,
  /**
   * `desdeElAlta`: la llama el propio carril del alta, que marca «cobro en curso» ANTES de cobrar; sin esto se bloquearía
   * a sí mismo en el paso 0. Todo lo demás (candado, confirmaciones abiertas, lo vivo en Stripe) aplica igual.
   */
  opciones: { desdeElAlta?: boolean } = {},
): Promise<T> {
  const limite = Date.now() + PRESUPUESTO_LECTURAS_MS
  const aTiempo = () => {
    if (Date.now() > limite) {
      throw new AppError(
        'No pudimos revisar los cobros de este negocio a tiempo. Inténtalo en unos minutos.',
        503,
        true,
        'OBLIGATIONS_UNVERIFIED',
      )
    }
  }
  const resultado = await prisma.$transaction(
    async (tx): Promise<Resultado<T>> => {
      const [candado] = await tx.$queryRaw<{ tomado: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtext(${`stripe-obligaciones:${venueId}`})) AS tomado`
      if (!candado?.tomado) {
        return {
          rechazo: new AppError(
            'Ya hay una compra en curso para este negocio. Inténtalo en un momento.',
            409,
            true,
            'PURCHASE_IN_PROGRESS',
          ),
          auditar: [],
        }
      }

      // 0. El alta económica en curso (su cobro todavía puede aparecer) no convive con otra compra.
      const venue = await tx.venue.findUnique({
        where: { id: venueId },
        select: {
          organization: {
            select: {
              onboardingCompletedAt: true,
              onboardingProgress: { select: { completedAt: true, planActivationStatus: true, planActivationLeaseUntil: true } },
            },
          },
        },
      })
      const org = venue?.organization
      const progreso = org?.onboardingProgress
      // La barrera cubre SÓLO el cobro que puede estar en vuelo (su suscripción quizá aún no se ve en Stripe): el lease de
      // `activatePlan` o una marca temprana reciente del carril viejo. Una marca vieja o un lease vencido no bloquean para
      // siempre: el inventario de abajo ya ve lo que ese cobro haya dejado vivo.
      const ahora = Date.now()
      const activatePlanEnVuelo =
        progreso?.planActivationStatus === 'IN_PROGRESS' && (progreso.planActivationLeaseUntil?.getTime() ?? 0) > ahora
      const altaViejaEnVuelo = Boolean(progreso?.completedAt && progreso.completedAt.getTime() > ahora - VENTANA_DEL_ALTA_MS)
      if (!opciones.desdeElAlta && progreso && !org?.onboardingCompletedAt && (activatePlanEnVuelo || altaViejaEnVuelo)) {
        return {
          rechazo: new AppError(
            'El alta de este negocio todavía está confirmando su pago. Inténtalo cuando termine.',
            409,
            true,
            'ONBOARDING_BILLING_IN_PROGRESS',
          ),
          auditar: [],
        }
      }

      // 1. A lo sumo una confirmación nuestra abierta: se expiran las que hay (completar y expirar son excluyentes).
      aTiempo()
      const abiertas = await stripe.checkout.sessions.list({ customer: customerId, status: 'open', limit: 100 }, STRIPE)
      if (abiertas.has_more)
        throw new AppError('No pudimos revisar todas las compras abiertas. Inténtalo en unos minutos.', 503, true, 'OBLIGATIONS_UNVERIFIED')
      for (const sesion of abiertas.data) {
        if (!esNuestra(sesion.metadata as Record<string, string> | null)) continue
        aTiempo()
        try {
          await stripe.checkout.sessions.expire(sesion.id, {}, STRIPE)
        } catch (error) {
          let estado: string | null = null
          try {
            estado = (await stripe.checkout.sessions.retrieve(sesion.id, {}, STRIPE)).status ?? null
          } catch {
            estado = null
          }
          if (estado === 'complete') {
            return {
              rechazo: new AppError(
                'Tu compra anterior ya se pagó; la estamos activando. Revisa en unos momentos.',
                409,
                true,
                'PURCHASE_ALREADY_COMPLETED',
              ),
              auditar: [],
            }
          }
          if (estado !== 'expired') {
            throw Object.assign(
              new AppError('No pudimos cerrar una compra abierta. Inténtalo en unos minutos.', 503, true, 'OBLIGATIONS_UNVERIFIED'),
              {
                cause: error,
              },
            )
          }
        }
      }

      // 2 y 3. Lo vivo en Stripe y su compatibilidad con lo que se quiere abrir.
      const { vivas, detalle, conCambiosProgramados } = await inventarioDeObligaciones(venueId, { limite })
      if (conCambiosProgramados.length) {
        return {
          rechazo: Object.assign(
            new AppError(
              'Este negocio tiene un cambio programado en su suscripción. Escríbenos para hacer la compra sin que se encimen.',
              409,
              true,
              'CAMBIOS_PROGRAMADOS',
            ),
            { suscripciones: conCambiosProgramados },
          ),
          auditar: [],
        }
      }
      const auditar: string[] = []
      for (const v of vivas) {
        if (!v.proyecciones.some(p => p.tipo === 'DESCONOCIDO')) continue
        const r = await registrarConflictoDeObligacion(tx, {
          venueId,
          subscriptionId: v.subscriptionId,
          customerId: detalle[v.subscriptionId]?.customerId ?? null,
          kind: 'UNKNOWN_PRODUCT',
          conflictsWith: [],
          detectedBy: 'autorizarObligacionNueva',
        })
        if (r === 'CREADO') auditar.push(v.subscriptionId)
      }
      const compat = evaluarCompatibilidad(vivas, intencion, elPlanConcede)
      if (!compat.ok) {
        return {
          rechazo: Object.assign(new AppError(MENSAJES[compat.codigo], 409, true, compat.codigo), { suscripciones: compat.suscripciones }),
          auditar,
        }
      }

      // Se crea sólo si queda presupuesto: la creación (con sus reintentos) cabe en lo que resta de la transacción.
      aTiempo()
      return { creado: await crear(), auditar }
    },
    { maxWait: 10_000, timeout: TIMEOUT_DE_LA_TRANSACCION_MS },
  )

  // Auditoría DESPUÉS de confirmar: un conflicto que no se guardó no deja rastro.
  for (const subscriptionId of resultado.auditar) {
    avisarConflictoCreado({ venueId, subscriptionId, kind: 'UNKNOWN_PRODUCT', detectedBy: 'autorizarObligacionNueva' })
  }
  if ('rechazo' in resultado) throw resultado.rechazo
  return resultado.creado
}
