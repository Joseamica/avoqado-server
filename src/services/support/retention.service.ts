import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { utcTs } from '@/utils/sqlDates'
import { SUPPORT_CONTACT, SUPPORT_NO_COVERAGE } from './texts'
import { getSupportAiConfig } from '@/config/supportWhatsapp'
import { persistSupportOutboundRoutes } from './outboundRoutes.service'

const day = 86400000
// Each category advances by at most 100 rows; no operator flag can stop privacy cleanup.
export async function purgeSupportBatch(now = new Date(), limit = 100): Promise<{ redacted: number; deleted: number }> {
  const take = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 100
  const old = new Date(now.getTime() - 30 * day),
    yesterday = new Date(now.getTime() - day),
    ninety = new Date(now.getTime() - 90 * day)
  return prisma.$transaction(
    async tx => {
      // Same order as reservation/settlement: budget before message, then attempt.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('support-ai-budget', 0))`
      let redacted = 0,
        deleted = 0
      const ai = getSupportAiConfig()
      await tx.$queryRaw`WITH abandoned AS (
        SELECT a.id FROM "SupportAttempt" a JOIN "SupportMessage" m ON m.id = a."messageId" JOIN "SupportConversation" c ON c.id = m."conversationId"
        WHERE a.kind = 'AI' AND a.state = 'RESERVED' AND (${!ai} OR a."pricingVersion" <> ${ai?.pricing.version ?? ''}
          OR m.status <> 'CLAIMED' OR m."claimToken" IS DISTINCT FROM a."claimToken" OR m."leaseUntil" IS NULL OR m."leaseUntil" <= ${utcTs(now)}
          OR m."expiresAt" <= ${utcTs(now)} OR m.generation <> c.generation OR c.mode = 'CLOSED' OR c."noticeAcceptedAt" IS NULL
          OR c."lastUserMessageAt" IS NULL OR c."lastUserMessageAt" > ${utcTs(now)} OR c."lastUserMessageAt" <= ${utcTs(now)} - INTERVAL '24 hours'
          OR c."lastActivityAt" > ${utcTs(now)} OR c."lastActivityAt" <= ${utcTs(now)} - INTERVAL '30 minutes')
        ORDER BY m."createdAt", a.id LIMIT ${take} FOR UPDATE OF a SKIP LOCKED
      ), stopped AS (
        UPDATE "SupportAttempt" a SET state = 'DEFINITIVE_FAILURE', "finishedAt" = ${utcTs(now)} FROM abandoned WHERE a.id = abandoned.id RETURNING a."reservedUsd", a.usage
      ), released AS (
        UPDATE "SupportBudget" SET "heldUsd" = "heldUsd" - COALESCE((SELECT SUM("reservedUsd") FROM stopped),0), "updatedAt" = ${utcTs(now)} WHERE key = 'AI:GLOBAL'
      ), counts AS (
        SELECT k.key, COUNT(*)::int AS n FROM stopped
        CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(stopped.usage->'reservation'->'countKeys') = 'array' THEN stopped.usage->'reservation'->'countKeys' ELSE '[]'::jsonb END) k(key)
        GROUP BY k.key
      ), quotas AS (
        UPDATE "SupportBudget" b SET "callCount" = GREATEST(0,b."callCount" - counts.n), "updatedAt" = ${utcTs(now)} FROM counts WHERE b.key = counts.key AND b.key <> 'AI:GLOBAL'
      ) SELECT COUNT(*)::int AS released FROM stopped`
      const messages = await tx.$queryRaw<
        { id: string; inboundEventId: string | null; outboundWamid: string | null; receiverId: string; createdAt: Date }[]
      >`SELECT m.id, m."inboundEventId", m."outboundWamid", m."createdAt", c."receiverId" FROM "SupportMessage" m JOIN "SupportConversation" c ON c.id = m."conversationId" WHERE m."createdAt" <= ${utcTs(old)} ORDER BY m."createdAt", m.id LIMIT ${take} FOR UPDATE OF m SKIP LOCKED`
      if (messages.length) {
        const ids = Prisma.join(messages.map(m => m.id))
        await persistSupportOutboundRoutes(
          messages.flatMap(m => (m.outboundWamid ? [{ receiverId: m.receiverId, wamid: m.outboundWamid, createdAt: m.createdAt }] : [])),
          tx,
          now,
        )
        await tx.$executeRaw`UPDATE "SupportBudget" SET "heldUsd" = "heldUsd" - COALESCE((SELECT SUM("reservedUsd") FROM "SupportAttempt" WHERE "messageId" IN (${ids}) AND kind = 'AI' AND state = 'RESERVED'), 0), "updatedAt" = ${utcTs(now)} WHERE key = 'AI:GLOBAL'`
        await tx.$executeRaw`WITH counts AS (
        SELECT k.key, COUNT(*)::int AS n FROM "SupportAttempt" a
        CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(a.usage->'reservation'->'countKeys') = 'array' THEN a.usage->'reservation'->'countKeys' ELSE '[]'::jsonb END) k(key)
        WHERE a."messageId" IN (${ids}) AND a.kind = 'AI' AND a.state = 'RESERVED' GROUP BY k.key
      ) UPDATE "SupportBudget" b SET "callCount" = GREATEST(0, b."callCount" - counts.n), "updatedAt" = ${utcTs(now)} FROM counts WHERE b.key = counts.key`
        // Numeric aggregates have no request, message, phone, staff, conversation or provider payload.
        await tx.$executeRaw`INSERT INTO "SupportBudget" (key, "windowStart", "callCount", "heldUsd", "spentUsd", "updatedAt")
        SELECT 'AI:ARCHIVE|' || a."pricingVersion" || '|' || CASE WHEN a.state IN ('STARTED','UNKNOWN') THEN 'UNKNOWN' ELSE 'SETTLED' END || '|' || to_char(m."createdAt", 'YYYY-MM'),
          date_trunc('month', m."createdAt"), COUNT(*)::int,
          SUM(CASE WHEN a.state IN ('STARTED','UNKNOWN') THEN a."reservedUsd" ELSE 0 END), SUM(COALESCE(a."actualUsd", 0)), ${utcTs(now)}
        FROM "SupportAttempt" a JOIN "SupportMessage" m ON m.id = a."messageId"
        WHERE m.id IN (${ids}) AND a.kind = 'AI' AND a.state <> 'RESERVED' AND (a."startedAt" IS NOT NULL OR a.state IN ('STARTED','UNKNOWN','SUCCEEDED'))
        GROUP BY a."pricingVersion", CASE WHEN a.state IN ('STARTED','UNKNOWN') THEN 'UNKNOWN' ELSE 'SETTLED' END, date_trunc('month', m."createdAt"), to_char(m."createdAt", 'YYYY-MM')
        ON CONFLICT (key) DO UPDATE SET "callCount" = "SupportBudget"."callCount" + EXCLUDED."callCount", "heldUsd" = "SupportBudget"."heldUsd" + EXCLUDED."heldUsd", "spentUsd" = "SupportBudget"."spentUsd" + EXCLUDED."spentUsd", "updatedAt" = EXCLUDED."updatedAt"`
        await tx.$executeRaw`UPDATE "WhatsappInboundEvent" e SET "replyWamid" = m."outboundWamid" FROM "SupportMessage" m WHERE m.id IN (${ids}) AND e.id = m."inboundEventId" AND m."outboundWamid" IS NOT NULL`
        await tx.supportAttempt.deleteMany({ where: { messageId: { in: messages.map(m => m.id) } } })
        deleted += (await tx.supportMessage.deleteMany({ where: { id: { in: messages.map(m => m.id) } } })).count
      }
      redacted += await tx.$executeRaw`WITH chosen AS (
      SELECT id FROM "SupportConversation" WHERE "selectionExpiresAt" <= ${utcTs(now)} AND "selectionOptions" IS NOT NULL AND "selectionOptions" <> 'null'::jsonb
      ORDER BY "selectionExpiresAt", id LIMIT ${take} FOR UPDATE SKIP LOCKED
    ) UPDATE "SupportConversation" c SET "selectionOptions" = NULL FROM chosen WHERE c.id = chosen.id`
      redacted += await tx.$executeRaw`WITH chosen AS (
      SELECT id FROM "SupportMessage" WHERE purpose = 'LINK_CODE' AND "expiresAt" <= ${utcTs(now)} AND "answerCipher" IS NOT NULL ORDER BY "expiresAt", id LIMIT ${take} FOR UPDATE SKIP LOCKED
    ) UPDATE "SupportMessage" m SET "answerCipher" = NULL, status = 'EXPIRED', "claimToken" = NULL, "leaseUntil" = NULL FROM chosen WHERE m.id = chosen.id`
      const challenges = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM "SupportLinkChallenge" WHERE "createdAt" <= ${utcTs(yesterday)} ORDER BY "createdAt", id LIMIT ${take} FOR UPDATE SKIP LOCKED`
      if (challenges.length) {
        const ids = challenges.map(c => c.id)
        await tx.supportMessage.updateMany({
          where: { challengeId: { in: ids } },
          data: { status: 'EXPIRED', challengeId: null, answerCipher: null, claimToken: null, leaseUntil: null },
        })
        deleted += (await tx.supportLinkChallenge.deleteMany({ where: { id: { in: ids } } })).count
      }
      redacted += await tx.$executeRaw`WITH chosen AS (
      SELECT id FROM "WhatsappInboundEvent" WHERE "routedAs" IN ('SUPPORT_QUEUED','SUPPORT_IGNORED') AND "receivedAt" <= ${utcTs(old)}
        AND ("fromPhone" <> '' OR "rawBody" <> '{}'::jsonb OR "routedSessionId" IS NOT NULL)
      ORDER BY "receivedAt", id LIMIT ${take} FOR UPDATE SKIP LOCKED
    ) UPDATE "WhatsappInboundEvent" e SET "fromPhone" = '', "rawBody" = '{}'::jsonb, "routedSessionId" = NULL, "messageType" = 'support_tombstone' FROM chosen WHERE e.id = chosen.id`
      deleted += await tx.$executeRaw`WITH chosen AS (
      SELECT e.id FROM "WhatsappInboundEvent" e WHERE e."routedAs" IN ('SUPPORT_QUEUED','SUPPORT_IGNORED') AND e."supportTombstoneUntil" <= ${utcTs(now)}
        AND NOT EXISTS (SELECT 1 FROM "SupportMessage" m WHERE m."inboundEventId" = e.id)
      ORDER BY e."supportTombstoneUntil", e.id LIMIT ${take} FOR UPDATE OF e SKIP LOCKED
    ) DELETE FROM "WhatsappInboundEvent" e USING chosen WHERE e.id = chosen.id`
      deleted += await tx.$executeRaw`WITH chosen AS (
      SELECT c.id FROM "SupportConversation" c WHERE c."lastActivityAt" <= ${utcTs(old)}
        AND NOT EXISTS (SELECT 1 FROM "SupportMessage" m WHERE m."conversationId" = c.id)
        AND NOT EXISTS (SELECT 1 FROM "SupportLinkChallenge" h WHERE h."conversationId" = c.id)
      ORDER BY c."lastActivityAt", c.id LIMIT ${take} FOR UPDATE OF c SKIP LOCKED
    ) DELETE FROM "SupportConversation" c USING chosen WHERE c.id = chosen.id`
      deleted += await tx.$executeRaw`WITH chosen AS (
      SELECT id FROM "SupportWhatsappLink" WHERE "expiresAt" <= ${utcTs(now)} ORDER BY "expiresAt", id LIMIT ${take} FOR UPDATE SKIP LOCKED
    ) DELETE FROM "SupportWhatsappLink" l USING chosen WHERE l.id = chosen.id`
      deleted += await tx.$executeRaw`WITH chosen AS (
      SELECT key FROM "SupportBudget" WHERE "windowStart" <= ${utcTs(old)} AND (key LIKE 'CONTROL:%' OR key LIKE 'AI:PHONE_%' OR key LIKE 'AI:STAFF_%')
        AND NOT EXISTS (SELECT 1 FROM "SupportAttempt" a WHERE a.kind = 'AI' AND a.state = 'RESERVED' AND a.usage->'reservation'->'countKeys' ? "SupportBudget".key)
      ORDER BY "windowStart", key LIMIT ${take} FOR UPDATE SKIP LOCKED
    ) DELETE FROM "SupportBudget" b USING chosen WHERE b.key = chosen.key`
      // Avisos (R1-05): sin `meta` a los 30 días; los terminados y los SupportEvent se borran a los 90. Sin FK: nunca frenan
      // la purga de mensajes y pláticas de arriba.
      redacted += await tx.$executeRaw`WITH chosen AS (
      SELECT id FROM "SupportNotice" WHERE "createdAt" <= ${utcTs(old)} AND meta IS NOT NULL ORDER BY "createdAt", id LIMIT ${take} FOR UPDATE SKIP LOCKED
    ) UPDATE "SupportNotice" n SET meta = NULL FROM chosen WHERE n.id = chosen.id`
      deleted += await tx.$executeRaw`WITH chosen AS (
      SELECT id FROM "SupportNotice" WHERE "createdAt" <= ${utcTs(ninety)}
        AND (status IN ('SENT','FAILED','SKIPPED','UNCERTAIN') OR (status = 'HELD' AND "digestId" IS NOT NULL))
      ORDER BY "createdAt", id LIMIT ${take} FOR UPDATE SKIP LOCKED
    ) DELETE FROM "SupportNotice" n USING chosen WHERE n.id = chosen.id`
      deleted += await tx.$executeRaw`WITH chosen AS (
      SELECT id FROM "SupportEvent" WHERE "createdAt" <= ${utcTs(ninety)} ORDER BY "createdAt", id LIMIT ${take} FOR UPDATE SKIP LOCKED
    ) DELETE FROM "SupportEvent" e USING chosen WHERE e.id = chosen.id`
      // La B: el registro de consultas y los desbloqueos del día se van a los 90 días; la aceptación se queda mientras exista la
      // persona. Sus respuestas cifradas (purpose DATA) ya se van a los 30 días con los mensajes de arriba, sin mirar el propósito.
      deleted += await tx.$executeRaw`WITH chosen AS (
      SELECT id FROM "SupportDataQuery" WHERE "createdAt" <= ${utcTs(ninety)} ORDER BY "createdAt", id LIMIT ${take} FOR UPDATE SKIP LOCKED
    ) DELETE FROM "SupportDataQuery" q USING chosen WHERE q.id = chosen.id`
      deleted += await tx.$executeRaw`WITH chosen AS (
      SELECT id FROM "SupportDataUnlock" WHERE "createdAt" <= ${utcTs(ninety)} ORDER BY "createdAt", id LIMIT ${take} FOR UPDATE SKIP LOCKED
    ) DELETE FROM "SupportDataUnlock" u USING chosen WHERE u.id = chosen.id`
      return { redacted, deleted }
    },
    { timeout: 15000 },
  )
}

export async function readSupportMetrics(now = new Date(), pricingCursor?: string) {
  if (pricingCursor && pricingCursor.length > 200) throw new Error('SUPPORT_METRICS_CURSOR_INVALID')
  return prisma.$transaction(
    async tx => {
      const states = await tx.supportMessage.groupBy({ by: ['status'], _count: true })
      const [summary] = await tx.$queryRaw<{ oldestSeconds: number; noCoverage: number; quota: number }[]>`SELECT
    COALESCE(MAX(GREATEST(0, EXTRACT(EPOCH FROM (${utcTs(now)} - "createdAt")))) FILTER (WHERE status IN ('QUEUED','CLAIMED','ANSWER_READY','AI_UNKNOWN')),0)::float8 AS "oldestSeconds",
    COUNT(*) FILTER (WHERE answer = ${SUPPORT_NO_COVERAGE})::int AS "noCoverage",
    COUNT(*) FILTER (WHERE answer = ${`Por ahora se alcanzó el límite de consultas del asistente. ${SUPPORT_CONTACT}`})::int AS quota FROM "SupportMessage"`
      const [pricing] = await tx.$queryRaw<
        { total: number; unknown: string; items: { pricingVersion: string; calls: string; heldUsd: string; spentUsd: string }[] }[]
      >`WITH entries AS (
    SELECT "pricingVersion", COUNT(*) FILTER (WHERE "startedAt" IS NOT NULL OR state IN ('STARTED','UNKNOWN','SUCCEEDED')) AS calls, SUM(CASE WHEN state IN ('RESERVED','STARTED','UNKNOWN') THEN "reservedUsd" ELSE 0 END) AS held,
      SUM(COALESCE("actualUsd",0)) AS spent, COUNT(*) FILTER (WHERE state IN ('STARTED','UNKNOWN')) AS unknown
    FROM "SupportAttempt" WHERE kind = 'AI' GROUP BY "pricingVersion"
    UNION ALL SELECT split_part(key,'|',2), "callCount", "heldUsd", "spentUsd", CASE WHEN split_part(key,'|',3) = 'UNKNOWN' THEN "callCount" ELSE 0 END FROM "SupportBudget" WHERE key LIKE 'AI:ARCHIVE|%'
  ), totals AS (SELECT "pricingVersion", SUM(calls)::bigint AS calls, SUM(held) AS "heldUsd", SUM(spent) AS "spentUsd", SUM(unknown)::bigint AS unknown FROM entries GROUP BY "pricingVersion"),
  page AS (SELECT * FROM totals ${pricingCursor ? Prisma.sql`WHERE "pricingVersion" > ${pricingCursor}` : Prisma.empty} ORDER BY "pricingVersion" LIMIT 101)
  SELECT (SELECT COUNT(*)::int FROM totals) AS total, (SELECT COALESCE(SUM(unknown),0)::text FROM totals) AS unknown,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('pricingVersion',"pricingVersion",'calls',calls::text,'heldUsd',"heldUsd"::text,'spentUsd',"spentUsd"::text) ORDER BY "pricingVersion") FROM page), '[]'::jsonb) AS items`
      const global = await tx.supportBudget.findUnique({ where: { key: 'AI:GLOBAL' }, select: { heldUsd: true } })
      const page = pricing.items.slice(0, 100)
      return {
        states: Object.fromEntries(states.map(s => [s.status, s._count])),
        ...summary,
        heldUsd: global?.heldUsd.toString() ?? '0',
        pricing: {
          total: pricing.total,
          hasMore: pricing.items.length > 100,
          nextCursor: pricing.items.length > 100 ? page[page.length - 1].pricingVersion : null,
          items: page.map(p => ({
            pricingVersion: p.pricingVersion,
            calls: Number(p.calls),
            heldUsd: new Prisma.Decimal(p.heldUsd).toString(),
            spentUsd: new Prisma.Decimal(p.spentUsd).toString(),
          })),
        },
        unknown: Number(pricing.unknown),
      }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  )
}
