import prisma from '@/utils/prismaClient'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import type { ConsentChannel } from '@prisma/client'

interface ConsentParams {
  venueId: string
  customerId: string
  channel: ConsentChannel
  actorStaffId?: string
  ip?: string
  userAgent?: string
}

/**
 * `content` va en el select a propósito (T10): es contenido del PROPIO negocio (no dato
 * personal de un tercero) y la ruta que lo expone exige `marketing:read` — el editor del
 * dashboard necesita el texto completo para precargarlo, no sólo sus metadatos.
 */
export async function getCurrentPrivacyNotice(venueId: string) {
  return prisma.privacyNoticeVersion.findFirst({
    where: { venueId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, content: true, contentHash: true, language: true, createdAt: true },
  })
}

/**
 * 🔴 El ÚNICO camino que escribe consentimiento. Evento + cache + ActivityLog en UNA
 * transacción — deliberadamente NO usa logAction (fire-and-forget): la revocación es
 * evidencia legal (LFPDPPP) y debe ser atómica con el evento (auditoría Codex #23).
 * El SELECT ... FOR UPDATE de la fila del customer da el orden total de `seq`.
 */
async function writeConsent(p: ConsentParams, action: 'GRANTED' | 'REVOKED') {
  await prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<{ id: string; venueId: string }[]>`
      SELECT id, "venueId" FROM "Customer" WHERE id = ${p.customerId} AND "venueId" = ${p.venueId} FOR UPDATE`
    if (rows.length === 0) throw new NotFoundError('Cliente no encontrado en este negocio')

    let noticeVersionId: string | null = null
    if (action === 'GRANTED') {
      const notice = await tx.privacyNoticeVersion.findFirst({
        where: { venueId: p.venueId },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      })
      if (!notice) throw new BadRequestError('Registra el aviso de privacidad del negocio antes de capturar consentimiento')
      noticeVersionId = notice.id
    }

    const last = await tx.consentEvent.findFirst({
      where: { customerId: p.customerId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    })
    const seq = (last?.seq ?? 0) + 1

    await tx.consentEvent.create({
      data: {
        customerId: p.customerId,
        venueId: p.venueId,
        seq,
        action,
        channel: p.channel,
        actorStaffId: p.actorStaffId ?? null,
        noticeVersionId,
        ip: p.ip ?? null,
        userAgent: p.userAgent ?? null,
      },
    })
    await tx.customer.update({ where: { id: p.customerId }, data: { marketingConsent: action === 'GRANTED' } })
    await tx.activityLog.create({
      data: {
        action: action === 'GRANTED' ? 'MARKETING_CONSENT_GRANTED' : 'MARKETING_CONSENT_REVOKED',
        entity: 'Customer',
        entityId: p.customerId,
        staffId: p.actorStaffId ?? null,
        venueId: p.venueId,
        data: { channel: p.channel, seq },
      },
    })
  })
}

export const grantMarketingConsent = (p: ConsentParams) => writeConsent(p, 'GRANTED')
export const revokeMarketingConsent = (p: ConsentParams) => writeConsent(p, 'REVOKED')
