import cuid from 'cuid'
import { createHash } from 'crypto'
import type { Prisma } from '@prisma/client'
import { isWhatsappWamid } from '@/utils/whatsappSanitize'

export async function persistSupportOutboundRoutes(
  rows: { receiverId: string; wamid: string; createdAt: Date }[],
  db: Prisma.TransactionClient,
  now = new Date(),
): Promise<void> {
  if (rows.length > 100) throw new Error('SUPPORT_OUTBOUND_BATCH_LIMIT')
  const data = rows
    .filter(row => isWhatsappWamid(row.wamid) && row.createdAt.getTime() + 90 * 86400000 > now.getTime())
    .map(row => ({
      id: cuid(),
      wamid: `support-outbound:${createHash('sha256').update(`${row.receiverId}\0${row.wamid}`).digest('hex')}`,
      receiverId: row.receiverId,
      replyWamid: row.wamid,
      fromPhone: '',
      rawBody: {},
      messageType: 'support_tombstone',
      routedAs: 'SUPPORT_IGNORED' as const,
      receivedAt: row.createdAt,
      processedAt: now,
      supportTombstoneUntil: new Date(row.createdAt.getTime() + 90 * 86400000),
    }))
  // The ACK owns this evidence even when content was erased during the HTTP request.
  if (data.length) await db.whatsappInboundEvent.createMany({ data, skipDuplicates: true })
}
