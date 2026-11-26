import logger from '../../config/logger'
import { getContext, runOutsideContext, runWithContext } from '../../observability/executionContext'
import prisma from '../../utils/prismaClient'
import { PLAN_ACTIVATION_STATUS } from '../launchCampaigns/launchCampaignEnums'
import { cerrarAltaSinNavegador } from './planActivation.service'
import { registrarSuscripcionDelIntento } from './registrarSuscripcionDelIntento'
import { terminarAltaCobradaSinRomper } from './terminarAltaCobrada'

/**
 * 🔴 H0 (28-oct-2026): el aviso de factura pagada de Stripe termina el alta si el navegador no lo hizo (autorizó con su
 * banco y cerró, o pagó y cerró antes de «Entrar»). Es el atajo rápido; la garantía es el barrido `altas-a-medio-pago`
 * (si el servidor se reinicia antes de que corra el temporizador, lo recoge el barrido). Nunca cobra ni anula: dispara los
 * dos cierres que ya existen, cada uno con su CAS.
 *
 * Espera 30 s para no pelear con el navegador que vuelve del banco y reenvía el pedido: lo normal es que él cierre primero
 * y este aviso no encuentre nada que hacer.
 */
export const ESPERA_DEL_AVISO_MS = 30_000

/**
 * B2 Task 5 (b2-r1 #1): la suscripción del aviso es de un intento que nunca guardó su id (la respuesta del `create` se perdió).
 * Lo dice SU metadata (la que trae la factura, sin otra llamada): la versión del editor con que se cobró, la organización y la
 * llave del intento. Si es el intento `IN_PROGRESS` de esa organización y sigue sin id, se registra con el CAS de siempre y se
 * devuelve la organización; si no, `null` (lo de hoy: nada).
 */
async function registrarPorLaMetadata(subscriptionId: string, metadata?: Record<string, string> | null): Promise<string | null> {
  const organizationId = metadata?.organizationId
  const llave = metadata?.planActivationKey
  if (!metadata?.planOfferVersion || !organizationId || !llave) return null
  const alta = await prisma.onboardingProgress.findUnique({
    where: { organizationId },
    select: { completedAt: true, planActivationStatus: true, planActivationAttempt: true, planStripeSubscriptionId: true },
  })
  if (!alta || alta.completedAt || alta.planActivationStatus !== PLAN_ACTIVATION_STATUS.IN_PROGRESS || alta.planStripeSubscriptionId)
    return null
  if (llave !== `plan-activation:${organizationId}:${alta.planActivationAttempt}`) return null
  if (!(await registrarSuscripcionDelIntento(organizationId, alta.planActivationAttempt, subscriptionId))) return null
  logger.info('Aviso de Stripe: se registró el id de la suscripción del intento del alta (no se había guardado)', {
    organizationId,
    subscriptionId,
  })
  return organizationId
}

export async function cerrarAltaPorAvisoDeStripe(subscriptionId: string, metadata?: Record<string, string> | null): Promise<void> {
  const alta = await prisma.onboardingProgress.findFirst({
    where: { planStripeSubscriptionId: subscriptionId, completedAt: null },
    select: { organizationId: true, planActivationStatus: true },
  })
  if (!alta) {
    const registrada = await registrarPorLaMetadata(subscriptionId, metadata)
    if (registrada) await cerrarAltaSinNavegador(registrada, 'aviso-stripe')
    return
  }
  if (alta.planActivationStatus === PLAN_ACTIVATION_STATUS.IN_PROGRESS) {
    await cerrarAltaSinNavegador(alta.organizationId, 'aviso-stripe')
  } else if (alta.planActivationStatus === PLAN_ACTIVATION_STATUS.ACTIVE) {
    await terminarAltaCobradaSinRomper(alta.organizationId, { via: 'aviso-stripe' })
  }
}

/**
 * `metadata`: la de la suscripción, tal como la trae la factura (`invoice.parent.subscription_details.metadata`, B2 Task 5);
 * con ella se cierra también el alta cuyo id nunca se guardó. Sin ella, lo de hoy.
 */
export function programarCierreDelAltaPorAviso(
  subscriptionId: string,
  metadata?: Record<string, string> | null,
  esperaMs = ESPERA_DEL_AVISO_MS,
): void {
  // El trabajo diferido corre con una copia del contexto del aviso que lo pidió (regla 8 de contexto-de-ejecucion.md).
  const capturado = getContext()
  const cerrar = () =>
    cerrarAltaPorAvisoDeStripe(subscriptionId, metadata).catch(error =>
      logger.warn('Aviso de Stripe: no se pudo terminar el alta (la retoma el barrido)', {
        subscriptionId,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  const temporizador = setTimeout(() => {
    void (capturado ? runWithContext({ ...capturado }, cerrar) : runOutsideContext(cerrar))
  }, esperaMs)
  temporizador.unref?.()
}
