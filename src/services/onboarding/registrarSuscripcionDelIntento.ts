import prisma from '../../utils/prismaClient'
import { PLAN_ACTIVATION_STATUS } from '../launchCampaigns/launchCampaignEnums'

/**
 * Planes editables B2, Task 5 (b2-r1 #1): registra el id de la suscripción de un intento del alta que nunca lo guardó (la
 * respuesta del `create` se perdió). La usan el barrido (`cerrarAltaSinNavegador`) y el aviso de Stripe.
 *
 * CAS: sólo si el alta sigue a medio pago en ESE intento y todavía sin id (otro camino pudo registrarlo, o el intento pudo
 * cambiar). Devuelve si tocó la fila. Sin efectos al importarse: vive aparte para que quien simula `planActivation.service`
 * (el aviso) siga probando este mismo CAS.
 */
export async function registrarSuscripcionDelIntento(organizationId: string, attempt: number, subscriptionId: string): Promise<boolean> {
  const { count } = await prisma.onboardingProgress.updateMany({
    where: {
      organizationId,
      planActivationAttempt: attempt,
      planActivationStatus: PLAN_ACTIVATION_STATUS.IN_PROGRESS,
      planStripeSubscriptionId: null,
    },
    data: { planStripeSubscriptionId: subscriptionId },
  })
  return count === 1
}
