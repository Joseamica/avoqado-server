import logger from '../../config/logger'
import { getContext, runOutsideContext, runWithContext } from '../../observability/executionContext'
import prisma from '../../utils/prismaClient'
import { PLAN_ACTIVATION_STATUS } from '../launchCampaigns/launchCampaignEnums'
import { cerrarAltaSinNavegador } from './planActivation.service'
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

export async function cerrarAltaPorAvisoDeStripe(subscriptionId: string): Promise<void> {
  const alta = await prisma.onboardingProgress.findFirst({
    where: { planStripeSubscriptionId: subscriptionId, completedAt: null },
    select: { organizationId: true, planActivationStatus: true },
  })
  if (!alta) return
  if (alta.planActivationStatus === PLAN_ACTIVATION_STATUS.IN_PROGRESS) {
    await cerrarAltaSinNavegador(alta.organizationId, 'aviso-stripe')
  } else if (alta.planActivationStatus === PLAN_ACTIVATION_STATUS.ACTIVE) {
    await terminarAltaCobradaSinRomper(alta.organizationId, { via: 'aviso-stripe' })
  }
}

export function programarCierreDelAltaPorAviso(subscriptionId: string, esperaMs = ESPERA_DEL_AVISO_MS): void {
  // El trabajo diferido corre con una copia del contexto del aviso que lo pidió (regla 8 de contexto-de-ejecucion.md).
  const capturado = getContext()
  const cerrar = () =>
    cerrarAltaPorAvisoDeStripe(subscriptionId).catch(error =>
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
