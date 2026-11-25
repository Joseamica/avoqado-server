/**
 * Planes editables (B2, Task 6, b2-r3 #3): la prueba SIN tarjeta que Stripe ya canceló antes de que el alta se cerrara.
 *
 * La prueba sin tarjeta se abre con `trial_settings.end_behavior.missing_payment_method: 'cancel'`: si al terminar sigue sin
 * tarjeta, Stripe la cancela (y `customer.subscription.deleted` apaga el acceso por el camino de hoy). Si el alta nunca se cerró
 * —la respuesta del `create` se perdió y la persona vuelve semanas después—, su intento seguía `IN_PROGRESS` esperando un cobro
 * que ya no va a llegar: hoy eso es un 503 eterno («estamos confirmando tu pago»). Aquí se reconoce y se cierra en Gratis.
 *
 * 🔴 Nunca toca Stripe más allá de leer las facturas, nunca crea ni cobra nada. Cada escritura es un CAS.
 */
import Stripe from 'stripe'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { ConflictError } from '../../errors/AppError'
import { logAction } from '../dashboard/activity-log.service'
import { PLAN_ACTIVATION_STATUS } from '../launchCampaigns/launchCampaignEnums'
import { fusionarV2SetupData } from './onboardingProgress.service'
import { terminarAltaCobrada, type ViaDelCierre } from './terminarAltaCobrada'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '')

/** Tope de facturas que se leen de la suscripción: con más, la historia no se vio completa y no es definitiva. */
const TOPE_DE_FACTURAS = 100

/** El 409 de la prueba que terminó sin tarjeta: el alta quedó en Gratis (el DASHBOARD sale del asistente, Task 11). */
export function pruebaTerminadaSinTarjeta(): ConflictError {
  return new ConflictError('Tu prueba terminó sin tarjeta y tu negocio quedó en Gratis. No se te cobró nada.', 'PLAN_TRIAL_ENDED')
}

/**
 * ¿Es la prueba sin tarjeta que terminó sin cobrar? Las cuatro: `canceled`; la metadata `sinTarjeta: 'true'` (Ruling P6, nunca
 * `trial_settings`); terminó al acabar su prueba o después (`ended_at ≥ trial_end`: cancelada antes no es «terminó sin
 * tarjeta», la canceló alguien); y ninguna factura pagada mayor que $0 en toda su historia. Las tres primeras se revisan sin
 * llamar a Stripe. Con más facturas que el tope, la historia no se vio entera: no es definitiva (`false`, el 503 de hoy). Un
 * error de Stripe sube («no pude ver» nunca es «no cobró»).
 */
export async function pruebaSinTarjetaTerminada(sub: Stripe.Subscription): Promise<boolean> {
  if (sub.status !== 'canceled' || sub.metadata?.sinTarjeta !== 'true') return false
  const finDeLaPrueba = sub.trial_end
  const terminada = (sub as unknown as { ended_at?: number | null }).ended_at
  if (typeof finDeLaPrueba !== 'number' || typeof terminada !== 'number' || terminada < finDeLaPrueba) return false
  const facturas = await stripe.invoices.list({ subscription: sub.id, status: 'paid', limit: TOPE_DE_FACTURAS })
  if (facturas.has_more) return false
  // Pagada mayor que $0: con tarjeta (`amount_paid`) o con saldo a favor (`total` cubierto sin cargo): las dos movieron dinero.
  return !facturas.data.some(f => f.status === 'paid' && ((f.total ?? 0) > 0 || (f.amount_paid ?? 0) > 0))
}

/**
 * Cierra el paso del plan del alta en Gratis y termina el alta.
 *
 * `Ruling:` se reusa `ACTIVE` con el plan `FREE` como «el paso del plan quedó resuelto», porque `terminarAltaCobrada` y
 * `completeV2Onboarding` sólo terminan el alta con `ACTIVE`. Costo si me equivoco: una lectura que tome `ACTIVE` por «pagó» vería
 * un alta en Gratis (B3 mide «pagó» por factura pagada).
 *
 * - El CAS exige el intento `IN_PROGRESS` sin terminar y su lease: el de la petición (`lease`, desde el PASO 6 de `activatePlan`)
 *   o, desde el barrido (`lease: null`), uno nulo o vencido. Si no toca la fila, no hace nada más (`false`).
 * - Deja la suscripción fuera del alta (`planStripeSubscriptionId: null`): ya no cobra nada. El plan guardado la nombra.
 * - Terminar el alta no cambia lo ya resuelto: si falla, lo retoma el barrido (como `terminarAltaCobradaSinRomper`).
 */
export async function cerrarAltaEnGratis(
  organizationId: string,
  intento: number,
  sub: Stripe.Subscription,
  lease: Date | null,
  opciones: { via: ViaDelCierre; staffId?: string },
): Promise<boolean> {
  const ahora = new Date()
  const numero = Number(sub.metadata?.planOfferVersion)
  const offerVersion = Number.isSafeInteger(numero) && numero >= 1 ? numero : null

  const cerrada = await prisma.$transaction(async tx => {
    const { count } = await tx.onboardingProgress.updateMany({
      where: {
        organizationId,
        completedAt: null,
        planActivationStatus: PLAN_ACTIVATION_STATUS.IN_PROGRESS,
        planActivationAttempt: intento,
        ...(lease
          ? { planActivationLeaseUntil: lease }
          : { OR: [{ planActivationLeaseUntil: null }, { planActivationLeaseUntil: { lt: ahora } }] }),
      },
      data: { planActivationStatus: PLAN_ACTIVATION_STATUS.ACTIVE, planActivationLeaseUntil: null, planStripeSubscriptionId: null },
    })
    if (count === 0) return false
    // `plan` en la RAÍZ (lo primero que lee `parseV2Plan`), y sólo esa sección, en la misma transacción que acreditó el CAS.
    await fusionarV2SetupData(tx, organizationId, {
      plan: {
        tier: 'FREE',
        pruebaSinTarjetaTerminada: true,
        subscriptionId: sub.id,
        ...(offerVersion !== null ? { offerVersion } : {}),
        acceptedAt: ahora.toISOString(),
      },
    })
    return true
  })
  if (!cerrada) return false

  logger.info('activate-plan: la prueba sin tarjeta terminó sin tarjeta antes de cerrar el alta — el alta queda en Gratis', {
    organizationId,
    subscriptionId: sub.id,
    via: opciones.via,
  })
  await logAction({
    ...(opciones.staffId ? { staffId: opciones.staffId } : {}),
    organizationId,
    action: 'PLAN_TRIAL_ENDED_ONBOARDING',
    entity: 'Organization',
    entityId: organizationId,
    data: { subscriptionId: sub.id, offerVersion, via: opciones.via },
  })
  try {
    await terminarAltaCobrada(organizationId, { via: opciones.via, ...(opciones.staffId ? { staffId: opciones.staffId } : {}) })
  } catch (error) {
    logger.error('🚨 La prueba sin tarjeta cerró el alta en Gratis pero no se pudo terminar el alta — la retoma el barrido', {
      organizationId,
      via: opciones.via,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return true
}
