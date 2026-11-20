import crypto from 'crypto'
import { Prisma, SupportMessageStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { utcTs } from '@/utils/sqlDates'

export interface SupportInput {
  receiverId: string
  wamid: string
  phone: string
  type: string
  body: string
  timestamp: string
  contextId?: string
}
export interface SupportClaim {
  messageId: string
  conversationId: string
  generation: number
  claimToken: string
  leaseUntil: Date
}
export async function admitSupportMessage(
  input: SupportInput,
  transaction?: Prisma.TransactionClient,
): Promise<{ messageId: string; duplicate: boolean }> {
  const admit = async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`support-event:${input.wamid}`}, 0))`
    const old = await tx.whatsappInboundEvent.findUnique({ where: { wamid: input.wamid }, include: { supportMessage: true } })
    if (old) return { messageId: old.supportMessage?.id ?? '', duplicate: true }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`support-phone:${input.receiverId}:${input.phone}`}, 0))`
    const now = new Date()
    let conversation = await tx.supportConversation.findFirst({
      where: { receiverId: input.receiverId, phone: input.phone, mode: { not: 'CLOSED' } },
    })
    if (!conversation) conversation = await tx.supportConversation.create({ data: { receiverId: input.receiverId, phone: input.phone } })
    const next = await tx.supportConversation.update({ where: { id: conversation.id }, data: { nextSequence: { increment: 1 } } })
    const event = await tx.whatsappInboundEvent.create({
      data: {
        wamid: input.wamid,
        fromPhone: input.phone,
        receiverId: input.receiverId,
        messageType: input.type,
        rawBody: {
          id: input.wamid,
          type: input.type,
          timestamp: input.timestamp,
          ...(input.contextId ? { contextId: input.contextId } : {}),
        },
        routedAs: 'SUPPORT_QUEUED',
        processedAt: now,
        supportTombstoneUntil: new Date(now.getTime() + 90 * 86_400_000),
      },
    })
    const message = await tx.supportMessage.create({
      data: {
        inboundEventId: event.id,
        conversationId: next.id,
        generation: next.generation,
        sequence: next.nextSequence,
        body: input.body,
        expiresAt: new Date(now.getTime() + 30 * 86_400_000),
      },
    })
    return { messageId: message.id, duplicate: false }
  }
  return transaction ? admit(transaction) : prisma.$transaction(admit)
}

const pending: SupportMessageStatus[] = ['QUEUED', 'CLAIMED', 'ANSWER_READY']

export async function claimNext(now = new Date(), receiverId?: string): Promise<SupportClaim | null> {
  return prisma.$transaction(async tx => {
    // One short global claim transaction also enforces the two-worker ceiling across processes.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('support-claims', 0))`
    const abandoned = await tx.$queryRaw<{ id: string }[]>`
      SELECT m.id FROM "SupportMessage" m JOIN "SupportConversation" c ON c.id = m."conversationId"
      WHERE m.status IN ('QUEUED','CLAIMED','ANSWER_READY') AND m."claimToken" IS NOT NULL AND m."leaseUntil" <= ${utcTs(now)}
      ${receiverId ? Prisma.sql`AND c."receiverId" = ${receiverId}` : Prisma.empty}
      ORDER BY m."leaseUntil", m.id LIMIT 20 FOR UPDATE OF m SKIP LOCKED`
    for (const row of abandoned) {
      // Lock before reading attempts: a completion which won the row must never be resurrected.
      const message = await tx.supportMessage.findUniqueOrThrow({
        where: { id: row.id },
        include: {
          attempts: { where: { state: { in: ['STARTED', 'UNKNOWN', 'SUCCEEDED'] } }, orderBy: { ordinal: 'desc' }, take: 4 },
        },
      })
      const send = message.attempts.find(a => a.kind === 'SEND')
      const ai = message.attempts.find(a => a.kind === 'AI')
      const status: SupportMessageStatus = send
        ? message.outboundWamid
          ? 'SENT'
          : 'SEND_UNKNOWN'
        : message.answer || message.answerCipher
          ? 'ANSWER_READY'
          : ai
            ? 'AI_UNKNOWN'
            : 'QUEUED'
      if (status === 'AI_UNKNOWN') {
        // Merge into the current row: a concurrent late settlement must retain its numeric usage too.
        await tx.$executeRaw`UPDATE "SupportAttempt" SET usage = jsonb_set(
          CASE WHEN jsonb_typeof(usage) = 'object' THEN usage ELSE '{}'::jsonb END, '{resultUnavailable}', 'true'::jsonb)
          WHERE "messageId" = ${message.id} AND kind = 'AI' AND state IN ('STARTED','UNKNOWN','SUCCEEDED')`
      }
      await tx.supportAttempt.updateMany({
        where: { messageId: message.id, state: 'STARTED' },
        data: { state: 'UNKNOWN', finishedAt: now },
      })
      await tx.supportMessage.update({ where: { id: message.id }, data: { status, claimToken: null, leaseUntil: null } })
    }
    const expired = await tx.$queryRaw<{ id: string }[]>`
      SELECT m.id FROM "SupportMessage" m JOIN "SupportConversation" c ON c.id = m."conversationId"
      WHERE m.status IN ('QUEUED','ANSWER_READY') AND m."claimToken" IS NULL AND m."expiresAt" <= ${utcTs(now)}
      ${receiverId ? Prisma.sql`AND c."receiverId" = ${receiverId}` : Prisma.empty}
      ORDER BY m."expiresAt", m.id LIMIT 20 FOR UPDATE OF m SKIP LOCKED`
    if (expired.length)
      await tx.supportMessage.updateMany({
        where: { id: { in: expired.map(m => m.id) } },
        data: {
          status: 'EXPIRED',
          answerCipher: null,
          claimToken: null,
          leaseUntil: null,
        },
      })
    const active = await tx.supportMessage.count({ where: { status: { in: pending }, claimToken: { not: null }, leaseUntil: { gt: now } } })
    if (active >= 2) return null
    const rows = await tx.$queryRaw<{ id: string; conversationId: string; generation: number }[]>`
      SELECT m.id, m."conversationId", m.generation FROM "SupportMessage" m
      JOIN "SupportConversation" c ON c.id = m."conversationId"
      WHERE m.status IN ('QUEUED','ANSWER_READY') AND m."claimToken" IS NULL
        AND m."nextAttemptAt" <= ${utcTs(now)} AND m."expiresAt" > ${utcTs(now)}
        AND c.mode <> 'CLOSED' AND c.generation = m.generation
        ${receiverId ? Prisma.sql`AND c."receiverId" = ${receiverId}` : Prisma.empty}
        AND NOT EXISTS (SELECT 1 FROM "SupportMessage" earlier WHERE earlier."conversationId" = c.id
          AND earlier.generation = c.generation AND earlier.sequence < m.sequence
          AND earlier.status IN ('QUEUED','CLAIMED','ANSWER_READY','AI_UNKNOWN'))
      ORDER BY m."nextAttemptAt", m.id LIMIT 1 FOR UPDATE OF m SKIP LOCKED`
    const row = rows[0]
    if (!row) return null
    const claimToken = crypto.randomBytes(24).toString('hex')
    const leaseUntil = new Date(now.getTime() + 90_000)
    await tx.supportMessage.update({ where: { id: row.id }, data: { claimToken, leaseUntil, status: 'CLAIMED' } })
    return { messageId: row.id, conversationId: row.conversationId, generation: row.generation, claimToken, leaseUntil }
  })
}

export async function completeClaim(
  claim: SupportClaim,
  patch: Prisma.SupportMessageUpdateManyMutationInput,
  now = new Date(),
  db: Prisma.TransactionClient = prisma,
): Promise<boolean> {
  const result = await db.supportMessage.updateMany({
    where: {
      id: claim.messageId,
      status: 'CLAIMED',
      conversationId: claim.conversationId,
      generation: claim.generation,
      claimToken: claim.claimToken,
      leaseUntil: { gt: now },
      conversation: { generation: claim.generation, mode: { not: 'CLOSED' } },
    },
    data: { ...patch, claimToken: null, leaseUntil: null },
  })
  return result.count === 1
}

export async function readCurrentClaim(tx: Prisma.TransactionClient, claim: SupportClaim, now = new Date()) {
  await tx.$queryRaw`SELECT id FROM "SupportMessage" WHERE id = ${claim.messageId} FOR UPDATE`
  return tx.supportMessage.findFirst({
    where: {
      id: claim.messageId,
      conversationId: claim.conversationId,
      generation: claim.generation,
      status: 'CLAIMED',
      claimToken: claim.claimToken,
      leaseUntil: { gt: now },
      expiresAt: { gt: now },
      conversation: { generation: claim.generation, mode: { not: 'CLOSED' } },
    },
    include: { conversation: true },
  })
}
