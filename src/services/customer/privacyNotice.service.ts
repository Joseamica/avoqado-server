/**
 * Aviso de privacidad del venue — Fase 0 (campañas de correo).
 *
 * `PrivacyNoticeVersion` es INMUTABLE (ver schema.prisma): esta función SIEMPRE crea una
 * fila nueva, nunca actualiza una existente. `consent.service.ts` es el único LECTOR
 * autorizado del aviso vigente (`getCurrentPrivacyNotice`, re-exportado aquí tal cual —
 * NO se reimplementa) porque es la misma versión que `writeConsent` usa para atar un
 * `ConsentEvent.noticeVersionId` al otorgar consentimiento.
 */
import crypto from 'crypto'
import prisma from '@/utils/prismaClient'
import { BadRequestError } from '@/errors/AppError'
import { logAction } from '../dashboard/activity-log.service'

export { getCurrentPrivacyNotice } from './consent.service'

export async function createPrivacyNoticeVersion(venueId: string, content: string, language: string, actorStaffId: string) {
  const limpio = content.trim()
  if (!limpio) throw new BadRequestError('El aviso de privacidad no puede estar vacío')

  const contentHash = crypto.createHash('sha256').update(limpio, 'utf8').digest('hex')

  const notice = await prisma.privacyNoticeVersion.create({
    data: { venueId, content: limpio, contentHash, language },
    select: { id: true },
  })

  // Fire-and-forget: publicar un aviso nuevo NO es evidencia de consentimiento (eso vive
  // en ConsentEvent, escrito atómicamente por consent.service). Aquí sí aplica la regla
  // normal del repo: registrar la mutación sin bloquear la respuesta.
  void logAction({
    staffId: actorStaffId,
    venueId,
    action: 'PRIVACY_NOTICE_VERSION_CREATED',
    entity: 'PrivacyNoticeVersion',
    entityId: notice.id,
    data: { language, contentHash },
  })

  return notice
}
