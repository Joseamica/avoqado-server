import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { admitSupportMessage } from '@/services/support/store.service'
import { purgeSupportBatch, readSupportMetrics } from '@/services/support/retention.service'
import { tryRouteSupport } from '@/services/support/router.service'
const cuid: () => string = require('cuid')

const receiverId = `support-retention-${Date.now()}`,
  phone = '+525500007001',
  day = 86400000
const now = new Date(),
  past = new Date(now.getTime() - 31 * day)
let serial = 0
const input = (body: string) => ({
  receiverId,
  phone,
  body,
  type: 'text',
  wamid: `${receiverId}-${++serial}`,
  timestamp: String(Date.now() / 1000),
})
async function clean() {
  await prisma.supportAttempt.deleteMany({ where: { message: { conversation: { receiverId } } } })
  await prisma.supportMessage.deleteMany({ where: { conversation: { receiverId } } })
  await prisma.supportLinkChallenge.deleteMany({ where: { conversation: { receiverId } } })
  await prisma.supportConversation.deleteMany({ where: { receiverId } })
  await prisma.whatsappInboundEvent.deleteMany({ where: { receiverId } })
  await prisma.supportBudget.deleteMany({
    where: { OR: [{ key: { startsWith: `CONTROL:${receiverId}:` } }, { key: { startsWith: 'AI:' } }] },
  })
}
beforeEach(async () => {
  await clean()
  Object.assign(process.env, {
    SUPPORT_WHATSAPP_ENABLED: 'false',
    SUPPORT_WHATSAPP_PHONE_NUMBER_ID: receiverId,
    WHATSAPP_SALES_PHONE_NUMBER_ID: 'sales',
    SUPPORT_WHATSAPP_ENC_KEY: 'e'.repeat(64),
  })
})
afterAll(clean)
async function oldMessage() {
  const row = await admitSupportMessage(input('PREGUNTA_PRIVADA'))
  const m = await prisma.supportMessage.update({
    where: { id: row.messageId },
    data: {
      createdAt: past,
      expiresAt: new Date(now.getTime() - day),
      status: 'SENT',
      answer: 'RESPUESTA_PRIVADA',
      accessFingerprint: 'PRIVATE',
      sourceIds: ['PRIVATE'],
      outboundWamid: `wamid.retention-${serial}`,
    },
  })
  await prisma.whatsappInboundEvent.update({
    where: { id: m.inboundEventId! },
    data: { receivedAt: past, rawBody: { secret: 'LEGACY_COPY' } },
  })
  await prisma.supportConversation.update({
    where: { id: m.conversationId },
    data: { lastActivityAt: past, selectionOptions: { secret: 'CONTEXTO_PRIVADO' }, staffId: 'c123456789012345678901234' },
  })
  return m
}
it('deletes content and context at 30 days while OFF, keeps only the minimal 90-day route and leaves legacy alone', async () => {
  const m = await oldMessage()
  const legacy = await prisma.whatsappInboundEvent.create({
    data: {
      receiverId,
      wamid: `${receiverId}-legacy`,
      fromPhone: phone,
      messageType: 'text',
      rawBody: { legacy: 'KEEP' },
      receivedAt: past,
      routedAs: 'VENUE_REPLY_ROUTED',
    },
  })
  const result = await purgeSupportBatch(now)
  expect(result.deleted).toBeGreaterThan(0)
  expect(await prisma.supportMessage.findUnique({ where: { id: m.id } })).toBeNull()
  expect(await prisma.supportConversation.findUnique({ where: { id: m.conversationId } })).toBeNull()
  expect(await prisma.whatsappInboundEvent.findUnique({ where: { id: m.inboundEventId! } })).toMatchObject({
    fromPhone: '',
    rawBody: {},
    routedSessionId: null,
    replyWamid: m.outboundWamid,
    routedAs: 'SUPPORT_QUEUED',
  })
  expect((await prisma.whatsappInboundEvent.findUniqueOrThrow({ where: { id: legacy.id } })).rawBody).toEqual({ legacy: 'KEEP' })
  expect(await purgeSupportBatch(now)).toEqual({ redacted: 0, deleted: 0 })
  expect(await tryRouteSupport({ ...input('Una duda'), contextId: m.outboundWamid! })).toBe('IGNORED')
  await purgeSupportBatch(new Date(now.getTime() + 91 * day))
  expect(await prisma.whatsappInboundEvent.findUnique({ where: { id: m.inboundEventId! } })).toBeNull()
  expect(await prisma.whatsappInboundEvent.findUnique({ where: { id: legacy.id } })).not.toBeNull()
})
it('archives numeric holds anonymously and releases only unstarted reservations, once across concurrent sweepers', async () => {
  const m = await oldMessage(),
    month = new Date(Date.UTC(past.getUTCFullYear(), past.getUTCMonth(), 1))
  const quotaKey = 'AI:PHONE_DAY:private-hash:old',
    monthKey = `AI:MONTH:${month.toISOString()}`
  await prisma.supportBudget.createMany({
    data: [
      { key: 'AI:GLOBAL', windowStart: month, heldUsd: '3' },
      { key: quotaKey, windowStart: month, callCount: 2 },
      { key: monthKey, windowStart: month, spentUsd: '0.25' },
    ],
  })
  for (const [ordinal, state, amount] of [
    [1, 'UNKNOWN', '1'],
    [2, 'RESERVED', '2'],
    [3, 'SUCCEEDED', '0'],
  ] as const)
    await prisma.supportAttempt.create({
      data: {
        messageId: m.id,
        kind: 'AI',
        ordinal,
        claimToken: 'private-token',
        state,
        requestId: 'req_private',
        pricingVersion: 'fixture-price',
        reservedUsd: amount,
        actualUsd: state === 'SUCCEEDED' ? '0.25' : null,
        startedAt: state === 'RESERVED' ? null : past,
        usage: { reservation: { monthKey, countKeys: [quotaKey] }, provider: { private: 'ERASE' } },
      },
    })
  await Promise.all([purgeSupportBatch(now), purgeSupportBatch(now)])
  expect(await prisma.supportAttempt.count({ where: { messageId: m.id } })).toBe(0)
  expect((await prisma.supportBudget.findUniqueOrThrow({ where: { key: 'AI:GLOBAL' } })).heldUsd.toString()).toBe('1')
  const archived = await prisma.supportBudget.findFirstOrThrow({ where: { key: { startsWith: 'AI:ARCHIVE|fixture-price|UNKNOWN|' } } })
  expect(archived).toMatchObject({ callCount: 1, heldUsd: new Prisma.Decimal(1), spentUsd: new Prisma.Decimal('0') })
  expect(JSON.stringify(archived)).not.toMatch(/private|req_|ERASE|5255/)
  const metrics = await readSupportMetrics(now)
  expect(metrics.heldUsd).toBe('1')
  expect(metrics.pricing.items).toContainEqual({ pricingVersion: 'fixture-price', calls: 2, heldUsd: '1', spentUsd: '0.25' })
})
it('expires encrypted OTP at 10 minutes and deletes the challenge at 24 hours without losing its opaque delivery evidence', async () => {
  const admission = await admitSupportMessage(input('AYUDA'))
  const source = await prisma.supportMessage.findUniqueOrThrow({ where: { id: admission.messageId } })
  const challenge = await prisma.supportLinkChallenge.create({
    data: {
      staffId: 'c123456789012345678901234',
      phone,
      conversationId: source.conversationId,
      operationKey: 'once',
      codeHash: 'hash',
      expiresAt: new Date(now.getTime() - 1),
      createdAt: new Date(now.getTime() - 600001),
    },
  })
  const code = await prisma.supportMessage.create({
    data: {
      conversationId: source.conversationId,
      sequence: 2,
      generation: 1,
      challengeId: challenge.id,
      purpose: 'LINK_CODE',
      status: 'ANSWER_READY',
      answerCipher: 'ENCRYPTED_OTP',
      expiresAt: challenge.expiresAt,
    },
  })
  await purgeSupportBatch(now)
  expect(await prisma.supportMessage.findUnique({ where: { id: code.id } })).toMatchObject({ status: 'EXPIRED', answerCipher: null })
  await purgeSupportBatch(new Date(now.getTime() + day))
  expect(await prisma.supportLinkChallenge.findUnique({ where: { id: challenge.id } })).toBeNull()
  expect(await prisma.supportMessage.findUnique({ where: { id: code.id } })).toMatchObject({ status: 'EXPIRED', challengeId: null })
})
it('offers PERSONA before consent, with no AI or automatically sent email, and rejects old replays after tombstones expire', async () => {
  process.env.SUPPORT_WHATSAPP_ENABLED = 'true'
  await tryRouteSupport(input('PERSONA'))
  const latest = await prisma.supportMessage.findFirstOrThrow({ where: { conversation: { receiverId } }, orderBy: { sequence: 'desc' } })
  expect(latest.answer).toContain('mailto:hola@avoqado.io')
  expect(latest.answer).toContain('No se ha abierto un ticket')
  expect(await prisma.supportAttempt.count({ where: { messageId: latest.id } })).toBe(0)
  expect(await tryRouteSupport({ ...input('AYUDA'), timestamp: String(past.getTime() / 1000) })).toBe('IGNORED')
})
it('enforces the hard batch ceiling and makes all eligible rows reachable on following sweeps', async () => {
  for (let i = 0; i < 3; i++) await oldMessage()
  await purgeSupportBatch(now, 1)
  expect(await prisma.supportMessage.count({ where: { conversation: { receiverId } } })).toBe(2)
  await purgeSupportBatch(now, 100000)
  expect(await prisma.supportMessage.count({ where: { conversation: { receiverId } } })).toBe(0)
})
it('erases an expired selector topic even when PERSONA keeps the conversation active', async () => {
  const m = await oldMessage()
  await prisma.supportConversation.update({
    where: { id: m.conversationId },
    data: {
      lastActivityAt: now,
      pendingSelection: 'VERSION',
      selectionExpiresAt: past,
      selectionOptions: { items: [], topic: 'PRIVATE_OLD_TOPIC' },
    },
  })
  await purgeSupportBatch(now)
  const conversation = await prisma.supportConversation.findUniqueOrThrow({ where: { id: m.conversationId } })
  expect(conversation.selectionOptions).toBeNull()
  expect(conversation.pendingSelection).toBe('VERSION')
})
it.each(['true', 'false'])('an old plain replay with no remaining tombstone stays ignored and minimal with flag %s', async flag => {
  process.env.SUPPORT_WHATSAPP_ENABLED = flag
  const event = { ...input('PRIVATE_OLD_QUESTION'), timestamp: String(past.getTime() / 1000) }
  expect(await tryRouteSupport(event)).toBe('IGNORED')
  const stored = await prisma.whatsappInboundEvent.findUniqueOrThrow({ where: { wamid: event.wamid } })
  expect(stored.rawBody).not.toHaveProperty('text')
  expect(JSON.stringify(stored.rawBody)).not.toContain('PRIVATE_OLD_QUESTION')
})
it('retains an opaque ninety-day quote tombstone for a delivered OTP which had no inbound event', async () => {
  const m = await oldMessage()
  const challenge = await prisma.supportLinkChallenge.create({
    data: {
      staffId: 'c123456789012345678901234',
      phone,
      conversationId: m.conversationId,
      operationKey: 'old-code',
      codeHash: '',
      expiresAt: past,
      createdAt: past,
    },
  })
  const code = await prisma.supportMessage.create({
    data: {
      conversationId: m.conversationId,
      sequence: 2,
      generation: 1,
      challengeId: challenge.id,
      purpose: 'LINK_CODE',
      status: 'SENT',
      outboundWamid: 'wamid.old-otp-fixture',
      expiresAt: past,
      createdAt: past,
    },
  })
  await purgeSupportBatch(now)
  expect(await prisma.supportMessage.findUnique({ where: { id: code.id } })).toBeNull()
  expect(await tryRouteSupport({ ...input('PRIVATE_QUOTED_QUESTION'), contextId: 'wamid.old-otp-fixture' })).toBe('IGNORED')
})
it('keeps exact numeric totals beyond a pricing page and exposes the next page', async () => {
  await prisma.supportBudget.createMany({
    data: Array.from({ length: 102 }, (_, i) => ({
      key: `AI:ARCHIVE|price-${String(i).padStart(3, '0')}|UNKNOWN|2030-01`,
      windowStart: now,
      callCount: 1,
      heldUsd: '0.5',
    })),
  })
  const first = await readSupportMetrics(now)
  expect(first.unknown).toBe(102)
  expect(first.pricing).toMatchObject({ total: 102, hasMore: true, nextCursor: 'price-099' })
  expect(first.pricing.items).toHaveLength(100)
  const second = await readSupportMetrics(now, first.pricing.nextCursor!)
  expect(second.unknown).toBe(102)
  expect(second.pricing).toMatchObject({ total: 102, hasMore: false, nextCursor: null })
  expect(second.pricing.items).toHaveLength(2)
  const empty = await readSupportMetrics(now, 'zzzz')
  expect(empty.pricing).toMatchObject({ total: 102, hasMore: false, items: [] })
  expect(empty.unknown).toBe(102)
})
it('rolls back both accounting and erasure when the later message deletion fails', async () => {
  const m = await oldMessage()
  await prisma.supportBudget.create({ data: { key: 'AI:GLOBAL', windowStart: past, heldUsd: '1' } })
  await prisma.supportAttempt.create({
    data: {
      messageId: m.id,
      kind: 'AI',
      ordinal: 1,
      claimToken: 'private',
      state: 'UNKNOWN',
      pricingVersion: 'rollback-price',
      reservedUsd: '1',
      startedAt: past,
    },
  })
  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION support_retention_fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture fail after accounting'; END $$`,
  )
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER support_retention_fixture_fail BEFORE DELETE ON "SupportMessage" FOR EACH ROW EXECUTE FUNCTION support_retention_fixture_fail()`,
  )
  try {
    await expect(purgeSupportBatch(now)).rejects.toThrow()
    expect(await prisma.supportMessage.findUnique({ where: { id: m.id } })).not.toBeNull()
    expect(await prisma.supportAttempt.count({ where: { messageId: m.id } })).toBe(1)
    expect(await prisma.supportBudget.count({ where: { key: { startsWith: 'AI:ARCHIVE|' } } })).toBe(0)
    expect((await prisma.supportBudget.findUniqueOrThrow({ where: { key: 'AI:GLOBAL' } })).heldUsd.toString()).toBe('1')
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER support_retention_fixture_fail ON "SupportMessage"`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION support_retention_fixture_fail()`)
  }
})
it.each([1000, 10000])(
  'cleans %i synthetic rows in reachable capped batches and records the actual index plan',
  async size => {
    const c = await prisma.supportConversation.create({ data: { receiverId, phone, lastActivityAt: past } })
    const events = Array.from({ length: size }, (_, i) => ({
      id: cuid(),
      wamid: `${receiverId}-scale-${i}`,
      fromPhone: phone,
      receiverId,
      messageType: 'text',
      rawBody: {},
      receivedAt: past,
      routedAs: 'SUPPORT_QUEUED' as const,
      supportTombstoneUntil: new Date(now.getTime() + 59 * day),
    }))
    await prisma.whatsappInboundEvent.createMany({ data: events })
    await prisma.supportMessage.createMany({
      data: events.map((e, i) => ({
        id: cuid(),
        inboundEventId: e.id,
        conversationId: c.id,
        generation: 1,
        sequence: i,
        body: 'SYNTHETIC',
        status: 'SENT' as const,
        createdAt: past,
        expiresAt: new Date(now.getTime() - day),
      })),
    })
    await prisma.$executeRawUnsafe('ANALYZE "SupportMessage"')
    const plan = await prisma.$queryRawUnsafe(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM "SupportMessage" WHERE "createdAt" <= TIMESTAMP '${past.toISOString().slice(0, -1)}' ORDER BY "createdAt", id LIMIT 100 FOR UPDATE SKIP LOCKED`,
    )
    const start = Date.now()
    for (let i = 0; i < size / 100; i++) await purgeSupportBatch(now, 100000)
    expect(await prisma.supportMessage.count({ where: { conversationId: c.id } })).toBe(0)
    expect(await prisma.whatsappInboundEvent.count({ where: { receiverId, fromPhone: '' } })).toBe(size)
    console.log(JSON.stringify({ supportRetentionScale: size, batches: size / 100, elapsedMs: Date.now() - start, plan }))
  },
  120000,
)
it('retention: after the 30-day purge of messages, no copy of any message text exists in SupportNotice or SupportEvent; notices never block that purge; terminal notices and events deleted after 90 days', async () => {
  const m = await oldMessage()
  const prefix = `handoff:${receiverId}:`
  const ninetyOne = new Date(now.getTime() - 91 * day)
  // The shape Task 5 writes, seeded with the message texts as a leaked copy would carry them: what the check at the end
  // proves is that the purge leaves no copy behind (meta cleared at 30 days, finished rows and old events gone at 90).
  const meta = {
    requestedAt: past.toISOString(),
    reason: 'REQUESTED',
    phone,
    app: 'dashboard',
    appVersion: null,
    deviceFamily: null,
    multipleProfiles: false,
    people: [{ staffId: cuid(), name: 'Persona Fixture', role: 'VIEWER', venues: [{ id: cuid(), name: 'Norte' }], organization: 'Org' }],
    guides: ['Crear productos', 'PREGUNTA_PRIVADA', 'RESPUESTA_PRIVADA'],
  }
  const notice = (
    label: string,
    status: 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED' | 'UNCERTAIN' | 'HELD',
    createdAt: Date,
    digestId?: string,
  ) => ({
    kind: 'HANDOFF' as const,
    dedupeKey: `${prefix}${label}`,
    day: '2026-01-01',
    status,
    conversationId: m.conversationId,
    generation: m.generation,
    meta,
    createdAt,
    ...(digestId ? { digestId } : {}),
  })
  const event = (sequence: number, createdAt: Date, guideIds = ['dashboard/menu/gestionar-productos']) => ({
    kind: 'UNKNOWN' as const,
    conversationId: m.conversationId,
    generation: m.generation,
    sequence,
    day: '2026-01-01',
    guideIds,
    createdAt,
  })
  const copies = async (secret: string) => {
    const [notices] = await prisma.$queryRaw<
      { n: number }[]
    >`SELECT COUNT(*)::int AS n FROM "SupportNotice" t WHERE to_jsonb(t)::text LIKE ${`%${secret}%`}`
    const [events] = await prisma.$queryRaw<
      { n: number }[]
    >`SELECT COUNT(*)::int AS n FROM "SupportEvent" t WHERE to_jsonb(t)::text LIKE ${`%${secret}%`}`
    return [notices.n, events.n]
  }
  try {
    await prisma.supportNotice.createMany({
      data: [
        notice('31-PENDING', 'PENDING', past),
        notice('31-SENT', 'SENT', past),
        notice('31-HELD', 'HELD', past),
        ...(['SENT', 'FAILED', 'SKIPPED', 'UNCERTAIN'] as const).map(s => notice(`91-${s}`, s, ninetyOne)),
        notice('91-HELD-DIGESTED', 'HELD', ninetyOne, cuid()),
        notice('91-HELD', 'HELD', ninetyOne),
        notice('91-PENDING', 'PENDING', ninetyOne),
      ],
    })
    await prisma.supportEvent.createMany({ data: [event(1, past), event(2, ninetyOne, ['PREGUNTA_PRIVADA', 'RESPUESTA_PRIVADA'])] })
    // Before the purge every seeded copy is there: the check below can fail.
    for (const secret of ['PREGUNTA_PRIVADA', 'RESPUESTA_PRIVADA']) expect(await copies(secret)).toEqual([10, 1])
    for (let i = 0; i < 3; i++) await purgeSupportBatch(now)
    // The notices point at the conversation without a key: its message and the conversation itself still go at 30 days.
    expect(await prisma.supportMessage.findUnique({ where: { id: m.id } })).toBeNull()
    expect(await prisma.supportConversation.findUnique({ where: { id: m.conversationId } })).toBeNull()
    const left = await prisma.supportNotice.findMany({
      where: { dedupeKey: { startsWith: prefix } },
      orderBy: { dedupeKey: 'asc' },
      take: 50,
    })
    // Past 90 days only what is not finished stays; past 30 days nothing keeps its meta.
    expect(left.map(n => n.dedupeKey.slice(prefix.length))).toEqual(['31-HELD', '31-PENDING', '31-SENT', '91-HELD', '91-PENDING'])
    expect(left.map(n => n.meta)).toEqual([null, null, null, null, null])
    expect((await prisma.supportEvent.findMany({ where: { conversationId: m.conversationId }, take: 10 })).map(e => e.sequence)).toEqual([
      1,
    ])
    // No copy of any message text anywhere in either table.
    for (const secret of ['PREGUNTA_PRIVADA', 'RESPUESTA_PRIVADA']) expect(await copies(secret)).toEqual([0, 0])
  } finally {
    await prisma.supportNotice.deleteMany({ where: { dedupeKey: { startsWith: prefix } } })
    await prisma.supportEvent.deleteMany({ where: { conversationId: m.conversationId } })
  }
})

// La B (case 32): a DATA answer lives up to 30 days like any message, whatever happened to its send; the log of queries and the
// day's unlocks go at 90 days, in the same batch that purges SupportEvent; the acceptance stays while the person exists.
it('a DATA message of 31 days is deleted with its cipher and one of 29 stays; log rows and unlocks of 91 days are deleted and those of 89 stay; the acceptance stays', async () => {
  const staffId = cuid(),
    venueId = cuid()
  const ago = (days: number) => new Date(now.getTime() - days * day)
  // SENT (kept after the send), FAILED (Meta's failure receipt after it) and SEND_UNKNOWN (claimNext after a STARTED send):
  // the three states in which a DATA row keeps its cipher once delivery is over.
  const dataMessage = async (status: 'SENT' | 'FAILED' | 'SEND_UNKNOWN', days: number) => {
    const row = await admitSupportMessage(input('¿cuánto vendí hoy?'))
    return prisma.supportMessage.update({
      where: { id: row.messageId },
      data: { purpose: 'DATA', status, answerCipher: `SEALED_${status}_${days}`, dataCapability: 'fake', createdAt: ago(days) },
    })
  }
  const old = [await dataMessage('SENT', 31), await dataMessage('FAILED', 31), await dataMessage('SEND_UNKNOWN', 31)]
  const young = [await dataMessage('SENT', 29), await dataMessage('FAILED', 29), await dataMessage('SEND_UNKNOWN', 29)]
  const log = (days: number) => ({
    staffId,
    venueId,
    capability: 'fake',
    paramsHmac: 'hmac',
    result: 'ANSWERED' as const,
    day: '2026-01-01',
    createdAt: ago(days),
  })
  await prisma.supportDataQuery.createMany({ data: [log(91), log(89)] })
  await prisma.supportDataUnlock.createMany({
    data: [91, 89].map(days => ({ staffId, venueId, day: `d-${days}`, linkId: 'link', unlockedAt: ago(days), createdAt: ago(days) })),
  })
  await prisma.supportDataAcceptance.create({ data: { staffId, linkId: 'link', noticeHash: 'hash', acceptedAt: ago(200) } })
  try {
    await purgeSupportBatch(now)
    for (const m of old) expect(await prisma.supportMessage.findUnique({ where: { id: m.id } })).toBeNull()
    for (const m of young)
      expect(await prisma.supportMessage.findUnique({ where: { id: m.id } })).toMatchObject({
        status: m.status,
        answerCipher: m.answerCipher,
      })
    const left = async (model: 'query' | 'unlock') =>
      (model === 'query'
        ? await prisma.supportDataQuery.findMany({ where: { staffId }, take: 10 })
        : await prisma.supportDataUnlock.findMany({ where: { staffId }, take: 10 })
      ).map(r => Math.round((now.getTime() - r.createdAt.getTime()) / day))
    expect(await left('query')).toEqual([89])
    expect(await left('unlock')).toEqual([89])
    expect(await prisma.supportDataAcceptance.findUnique({ where: { staffId } })).not.toBeNull()
    // A later pass has nothing more of la B to delete.
    await purgeSupportBatch(now)
    expect(await left('query')).toEqual([89])
    expect(await left('unlock')).toEqual([89])
  } finally {
    await prisma.supportDataQuery.deleteMany({ where: { staffId } })
    await prisma.supportDataUnlock.deleteMany({ where: { staffId } })
    await prisma.supportDataAcceptance.deleteMany({ where: { staffId } })
  }
})

// The three indexes are built CONCURRENTLY, one migration each (the table already takes writes). An interrupted
// CONCURRENTLY build leaves the index present but INVALID, so "the migrations ran" is not enough: each must be valid.
it('the migrations leave the three inbound-event indexes valid, on the same columns as schema.prisma', async () => {
  const rows = await prisma.$queryRaw<{ indexname: string; indexdef: string; valid: boolean }[]>`
    SELECT i.indexname, i.indexdef, x.indisvalid AS valid
    FROM pg_indexes i JOIN pg_class c ON c.relname = i.indexname JOIN pg_index x ON x.indexrelid = c.oid
    WHERE i.tablename = 'WhatsappInboundEvent' AND i.indexname IN (
      'WhatsappInboundEvent_routedAs_receivedAt_id_idx',
      'WhatsappInboundEvent_supportTombstoneUntil_id_idx',
      'WhatsappInboundEvent_receiverId_replyWamid_idx')
    ORDER BY i.indexname`
  expect(rows.map(r => [r.indexname, r.valid, r.indexdef.slice(r.indexdef.indexOf('USING'))])).toEqual([
    ['WhatsappInboundEvent_receiverId_replyWamid_idx', true, 'USING btree ("receiverId", "replyWamid")'],
    ['WhatsappInboundEvent_routedAs_receivedAt_id_idx', true, 'USING btree ("routedAs", "receivedAt", id)'],
    ['WhatsappInboundEvent_supportTombstoneUntil_id_idx', true, 'USING btree ("supportTombstoneUntil", id)'],
  ])
})
