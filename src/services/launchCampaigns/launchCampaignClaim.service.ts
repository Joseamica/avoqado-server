/**
 * S6 — RECLAMAR una campaña: qué anuncio trajo a esta organización (spec 2026-09-17 § 3.5).
 *
 * 🔴 Reclamar NO aparta un lugar del cupo y NO cobra nada. Es atribución. Por eso
 * `findClaimableByCodeOrSlug` a propósito **no** mira el cupo: negarle el reclamo a alguien porque la
 * campaña está llena perdería justo el dato que la campaña existe para producir.
 *
 * 🔴 ÚLTIMO TOQUE, y sólo mientras no haya cobro: un reclamo nuevo reemplaza al anterior si el
 * alta sigue abierta y el plan no se ha activado. Una vez que hay `planActivationStatus` ACTIVE
 * o IN_PROGRESS, el reclamo queda congelado — cambiarlo debajo de un cobro en vuelo haría que
 * el correo de confirmación hablara de una campaña y el cargo fuera de otra.
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { logAction } from '../dashboard/activity-log.service'
import { findClaimableByCodeOrSlug } from './launchCampaign.service'
import { PLAN_ACTIVATION_STATUS } from './launchCampaignEnums'
import type { AcquisitionSource } from '../../schemas/acquisition.schema'

export interface ClaimResult {
  claimed: boolean
  campaignId: string | null
  code: string | null
}

/**
 * Reclama (o re-reclama) una campaña para una organización que sigue dándose de alta.
 *
 * 🔴 NUNCA lanza. Un código inválido, una ficha pausada o una carrera dejan el alta intacta y un
 * `logger.warn`: perder la atribución cuesta un dato de marketing; tumbar el alta cuesta el cliente.
 */
export async function claimLaunchCampaign(
  organizationId: string,
  code: string | undefined | null,
  source: AcquisitionSource | string,
  utm?: Record<string, string>,
  staffId?: string | null,
): Promise<ClaimResult> {
  const vacio: ClaimResult = { claimed: false, campaignId: null, code: null }
  if (!code) return vacio

  try {
    const campaign = await findClaimableByCodeOrSlug(code)
    if (!campaign) {
      logger.warn('launchCampaign: código no reclamable, el alta sigue sin campaña', { organizationId, code })
      return vacio
    }

    const r = await prisma.onboardingProgress.updateMany({
      where: {
        organizationId,
        // 🔴 Las dos condiciones que hacen seguro el «último toque»: el alta tiene que seguir
        // abierta y el cobro no puede haber empezado.
        completedAt: null,
        planActivationStatus: { in: [PLAN_ACTIVATION_STATUS.NONE, PLAN_ACTIVATION_STATUS.DECLINED] },
      },
      data: {
        launchCampaignId: campaign.id,
        launchCampaignClaimedAt: new Date(),
        acquisitionSource: source,
        // Sólo se escriben UTMs cuando de verdad vienen: un `{}` en cada alta orgánica no dice
        // nada y además borraría los que la visita anterior sí traía.
        ...(utm && Object.keys(utm).length > 0 ? { acquisitionUtm: utm as Prisma.InputJsonValue } : {}),
      },
    })

    if (r.count === 0) {
      logger.warn('launchCampaign: no se pudo reclamar (alta terminada o cobro en curso)', { organizationId, code })
      return vacio
    }

    await logAction({
      staffId: staffId ?? null,
      organizationId,
      action: 'LAUNCH_CAMPAIGN_CLAIMED',
      entity: 'OnboardingProgress',
      entityId: organizationId,
      data: { organizationId, code: campaign.code, campaignId: campaign.id, source },
    })
    return { claimed: true, campaignId: campaign.id, code: campaign.code }
  } catch (error) {
    logger.warn('launchCampaign: el reclamo falló; el alta sigue', {
      organizationId,
      code,
      error: error instanceof Error ? error.message : String(error),
    })
    return vacio
  }
}
