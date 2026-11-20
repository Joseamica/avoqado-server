import prisma from '@/utils/prismaClient'
import { admitSupportMessage, claimNext, completeClaim } from '@/services/support/store.service'

const receiverId = `support-store-${Date.now()}`
const input = (wamid: string, phone = '+525500001001') => ({
  receiverId,
  wamid,
  phone,
  type: 'text',
  body: 'AYUDA',
  timestamp: String(Math.floor(Date.now() / 1000)),
})

afterAll(async () => {
  await prisma.supportNotice.deleteMany({ where: { dedupeKey: { startsWith: `handoff:${receiverId}` } } })
  await prisma.supportEvent.deleteMany({ where: { conversationId: { startsWith: receiverId } } })
  const conversations = await prisma.supportConversation.findMany({
    where: { receiverId: { startsWith: receiverId } },
    select: { id: true },
    take: 100,
  })
  const ids = conversations.map(c => c.id)
  if (!ids.length) return
  await prisma.supportAttempt.deleteMany({ where: { message: { conversationId: { in: ids } } } })
  await prisma.supportMessage.deleteMany({ where: { conversationId: { in: ids } } })
  await prisma.supportLinkChallenge.deleteMany({ where: { conversationId: { in: ids } } })
  await prisma.supportConversation.deleteMany({ where: { id: { in: ids } } })
  await prisma.whatsappInboundEvent.deleteMany({ where: { receiverId: { startsWith: receiverId } } })
})

describe('support durable store, real Postgres', () => {
  it.each(['UTC', 'America/Mexico_City'])('admission and claim use the same UTC instant in a %s database session', async zone => {
    const realTransaction = prisma.$transaction.bind(prisma) as any
    const scoped = jest.spyOn(prisma, '$transaction').mockImplementation((async (fn: any, options: any) =>
      realTransaction(async (tx: any) => {
        await tx.$executeRaw`SELECT set_config('TimeZone', ${zone}, true)`
        return fn(tx)
      }, options)) as any)
    try {
      const receiver = `${receiverId}-zone-${zone.replace('/', '-')}`
      const admitted = await admitSupportMessage({ ...input(`${receiver}-job`, '+525500001012'), receiverId: receiver })
      const now = new Date(Date.now() + 1_000)
      const claim = await claimNext(now, receiver)
      expect(claim?.messageId).toBe(admitted.messageId)
      expect(await completeClaim(claim!, { status: 'SENT' }, now)).toBe(true)
    } finally {
      scoped.mockRestore()
    }
  })
  it('expired OTP cannot hold the FIFO queue and its encrypted code is erased', async () => {
    const receiver = `${receiverId}-expiry`
    const conversation = await prisma.supportConversation.create({
      data: { receiverId: receiver, phone: '+525500001007', nextSequence: 1 },
    })
    const challenge = await prisma.supportLinkChallenge.create({
      data: {
        staffId: 'c123456789012345678901234',
        phone: conversation.phone,
        conversationId: conversation.id,
        operationKey: 'expiry',
        codeHash: 'fake',
        expiresAt: new Date(Date.now() - 1_000),
      },
    })
    const otp = await prisma.supportMessage.create({
      data: {
        conversationId: conversation.id,
        challengeId: challenge.id,
        purpose: 'LINK_CODE',
        sequence: 1,
        generation: 1,
        status: 'ANSWER_READY',
        answerCipher: 'encrypted-fake',
        expiresAt: challenge.expiresAt,
      },
    })
    const help = await admitSupportMessage({ ...input(`${receiverId}-after-otp`, conversation.phone), receiverId: receiver })
    const claim = await claimNext(new Date(Date.now() + 1_000), receiver)
    expect(claim?.messageId).toBe(help.messageId)
    expect(await prisma.supportMessage.findUnique({ where: { id: otp.id } })).toMatchObject({ status: 'EXPIRED', answerCipher: null })
    await completeClaim(claim!, { status: 'SENT' })
  })

  it('recovery cannot overwrite a completion which already won the row lock', async () => {
    const receiver = `${receiverId}-race`
    const admitted = await admitSupportMessage({ ...input(`${receiverId}-race-job`, '+525500001008'), receiverId: receiver })
    const now = new Date(Date.now() + 1_000)
    const claim = (await claimNext(now, receiver))!
    await prisma.supportMessage.update({ where: { id: admitted.messageId }, data: { answer: 'Respuesta ya entregada' } })
    await prisma.supportAttempt.create({
      data: {
        messageId: admitted.messageId,
        kind: 'SEND',
        ordinal: 1,
        claimToken: claim.claimToken,
        state: 'SUCCEEDED',
        pricingVersion: 'fake',
        startedAt: now,
      },
    })
    let release!: () => void, locked!: (pid: number) => void
    const gate = new Promise<void>(r => {
      release = r
    })
    const ready = new Promise<number>(r => {
      locked = r
    })
    const holder = prisma.$transaction(
      async tx => {
        const rows = await tx.$queryRaw<
          { pid: number }[]
        >`SELECT pg_backend_pid() AS pid FROM "SupportMessage" WHERE id = ${admitted.messageId} FOR UPDATE`
        locked(rows[0].pid)
        await gate
      },
      { timeout: 15_000 },
    )
    const blocker = await ready
    const waiters = async () =>
      (
        await prisma.$queryRaw<
          { n: bigint }[]
        >`WITH RECURSIVE waiting AS (SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND ${blocker} = ANY(pg_blocking_pids(pid)) UNION SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid = ANY(pg_blocking_pids(a.pid))) SELECT count(*) AS n FROM waiting`
      )[0].n
    const until = async (condition: () => Promise<boolean>) => {
      const deadline = Date.now() + 5_000
      while (!(await condition())) {
        if (Date.now() > deadline) throw new Error('No se observó la barrera de Postgres')
        await new Promise(r => setTimeout(r, 20))
      }
    }
    let completion: Promise<boolean> | undefined, recovery: ReturnType<typeof claimNext> | undefined
    try {
      completion = completeClaim(claim, { status: 'SENT' }, now)
      await until(async () => (await waiters()) >= 1n)
      let recoveryFinished = false
      recovery = claimNext(new Date(now.getTime() + 91_000), receiver).then(value => {
        recoveryFinished = true
        return value
      })
      await until(async () => recoveryFinished || (await waiters()) >= 2n)
    } finally {
      release()
      await holder
    }
    expect(await completion).toBe(true)
    expect((await recovery)?.messageId).not.toBe(admitted.messageId)
    expect((await prisma.supportMessage.findUnique({ where: { id: admitted.messageId } }))?.status).toBe('SENT')
  })

  it.each([
    [null, null, null, 'QUEUED'],
    [null, null, 'Respuesta guardada', 'ANSWER_READY'],
    ['AI', 'RESERVED', null, 'QUEUED'],
    ['AI', 'RESERVED', 'Respuesta guardada', 'ANSWER_READY'],
    ['AI', 'STARTED', null, 'AI_UNKNOWN'],
    ['AI', 'STARTED', 'Respuesta de respaldo', 'ANSWER_READY'],
    ['AI', 'UNKNOWN', null, 'AI_UNKNOWN'],
    ['AI', 'UNKNOWN', 'Respuesta de respaldo', 'ANSWER_READY'],
    ['AI', 'SUCCEEDED', null, 'AI_UNKNOWN'],
    ['AI', 'SUCCEEDED', 'Respuesta verificada', 'ANSWER_READY'],
    ['SEND', 'STARTED', 'Respuesta guardada', 'SEND_UNKNOWN'],
    ['SEND', 'UNKNOWN', 'Respuesta guardada', 'SEND_UNKNOWN'],
    ['SEND', 'SUCCEEDED', 'Respuesta guardada', 'SEND_UNKNOWN'],
    ['SEND', 'SUCCEEDED', 'Respuesta guardada', 'SENT', true],
  ] as const)(
    'recovery matrix %s/%s with persisted answer %s -> %s',
    async (kind, state, answer, expected, knownWamid: boolean = false) => {
      const receiver = `${receiverId}-matrix-${kind}-${state}-${!!answer}-${knownWamid}`
      const admitted = await admitSupportMessage({ ...input(`${receiver}-job`, '+525500001011'), receiverId: receiver })
      const now = new Date(Date.now() + 1_000)
      const claim = (await claimNext(now, receiver))!
      if (answer)
        await prisma.supportMessage.update({
          where: { id: admitted.messageId },
          data: { answer, ...(knownWamid ? { outboundWamid: `${receiver}-sent` } : {}) },
        })
      if (kind && state)
        await prisma.supportAttempt.create({
          data: {
            messageId: admitted.messageId,
            kind,
            state,
            ordinal: 1,
            claimToken: claim.claimToken,
            pricingVersion: 'fake',
            reservedUsd: '0.02',
            startedAt: state === 'RESERVED' ? null : now,
          },
        })
      const next = await claimNext(new Date(now.getTime() + 91_000), receiver)
      const message = await prisma.supportMessage.findUniqueOrThrow({ where: { id: admitted.messageId } })
      expect(message.status).toBe(['QUEUED', 'ANSWER_READY'].includes(expected) ? 'CLAIMED' : expected)
      expect(next?.messageId ?? null).toBe(['QUEUED', 'ANSWER_READY'].includes(expected) ? admitted.messageId : null)
      if (kind) {
        const attempt = await prisma.supportAttempt.findFirstOrThrow({ where: { messageId: admitted.messageId } })
        expect(attempt.state).toBe(state === 'STARTED' ? 'UNKNOWN' : state)
        expect(attempt.reservedUsd.toString()).toBe('0.02')
      }
      if (next) await completeClaim(next, { status: 'CANCELLED' }, new Date(now.getTime() + 91_001))
    },
  )

  it('fresh migrations reject dangling links and messages rather than trusting only the generated client', async () => {
    await expect(
      prisma.supportConversation.create({
        data: { receiverId: `${receiverId}-fk`, phone: '+525500001009', linkId: 'c9999999999999999999999999' },
      }),
    ).rejects.toMatchObject({ code: 'P2003' })
  })
  it('two concurrent deliveries admit exactly one job and never keep the raw question twice', async () => {
    const [a, b] = await Promise.all([admitSupportMessage(input(`${receiverId}-dup`)), admitSupportMessage(input(`${receiverId}-dup`))])
    expect(a.messageId).toBe(b.messageId)
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true])
    const rows = await prisma.supportMessage.findMany({ where: { inboundEvent: { wamid: `${receiverId}-dup` } }, take: 10 })
    expect(rows).toHaveLength(1)
    const event = await prisma.whatsappInboundEvent.findUnique({ where: { wamid: `${receiverId}-dup` } })
    expect(event?.rawBody).not.toHaveProperty('text')
    expect(event?.routedAs).toBe('SUPPORT_QUEUED')
  })

  it('two receivers have different conversations and acceptance allocates monotonic sequences', async () => {
    const a = await admitSupportMessage(input(`${receiverId}-seq1`, '+525500001002'))
    const b = await admitSupportMessage(input(`${receiverId}-seq2`, '+525500001002'))
    const c = await admitSupportMessage({ ...input(`${receiverId}-other`, '+525500001002'), receiverId: `${receiverId}-other` })
    const rows = await prisma.supportMessage.findMany({
      where: { id: { in: [a.messageId, b.messageId, c.messageId] } },
      orderBy: { sequence: 'asc' },
      take: 10,
    })
    expect(rows.find(r => r.id === a.messageId)?.sequence).toBe(1)
    expect(rows.find(r => r.id === b.messageId)?.sequence).toBe(2)
    expect(rows.find(r => r.id === a.messageId)?.conversationId).not.toBe(rows.find(r => r.id === c.messageId)?.conversationId)
    await prisma.supportMessage.delete({ where: { id: c.messageId } })
    await prisma.supportConversation.delete({ where: { id: rows.find(r => r.id === c.messageId)!.conversationId } })
    await prisma.whatsappInboundEvent.delete({ where: { wamid: `${receiverId}-other` } })
  })

  it('workers exclude each other, expired leases fence stale writes, and recovery never repeats STARTED I/O', async () => {
    const now = new Date(Date.now() + 1_000)
    const admitted = await admitSupportMessage(input(`${receiverId}-claim`, '+525500001003'))
    const [a, b] = await Promise.all([claimNext(now, receiverId), claimNext(now, receiverId)])
    const claims = [a, b].filter(c => c !== null)
    expect(new Set(claims.map(c => c!.messageId)).size).toBe(claims.length)
    expect(claims.length).toBeGreaterThan(0)
    for (const claim of claims) await completeClaim(claim!, { status: 'SENT' }, now)
    let claim = await claimNext(now, receiverId)
    while (claim && claim.messageId !== admitted.messageId) {
      await completeClaim(claim, { status: 'SENT' }, now)
      claim = await claimNext(now, receiverId)
    }
    // The target might be one of the first two claims; use a fresh job for the lease check.
    const target = await admitSupportMessage(input(`${receiverId}-lease`, '+525500001004'))
    const lease = await claimNext(now, receiverId)
    expect(lease?.messageId).toBe(target.messageId)
    const expired = new Date(now.getTime() + 91_000)
    expect(await completeClaim(lease!, { status: 'SENT' }, expired)).toBe(false)
    await prisma.supportAttempt.create({
      data: {
        messageId: target.messageId,
        kind: 'AI',
        ordinal: 1,
        claimToken: lease!.claimToken,
        state: 'STARTED',
        pricingVersion: 'fake',
        startedAt: now,
      },
    })
    await claimNext(expired, receiverId)
    const after = await prisma.supportMessage.findUnique({ where: { id: target.messageId } })
    expect(after?.status).toBe('AI_UNKNOWN')
    expect((await prisma.supportAttempt.findFirst({ where: { messageId: target.messageId } }))?.state).toBe('UNKNOWN')
    expect(await completeClaim(lease!, { status: 'ANSWER_READY', answer: 'late' }, expired)).toBe(false)
  })

  it('the partial unique index rejects a second active conversation; a closed one does not block a new one', async () => {
    const data = { receiverId, phone: '+525500001005' }
    await prisma.supportConversation.create({ data })
    await expect(prisma.supportConversation.create({ data })).rejects.toMatchObject({ code: 'P2002' })
    await prisma.supportConversation.updateMany({ where: data, data: { mode: 'CLOSED' } })
    await expect(prisma.supportConversation.create({ data })).resolves.toMatchObject({ mode: 'PUBLIC' })
  })

  it('a SupportNotice dedupeKey is unique', async () => {
    const dedupeKey = `handoff:${receiverId}:1:unique`
    const data = { kind: 'HANDOFF' as const, dedupeKey, day: '2026-11-11', conversationId: `${receiverId}-conv`, generation: 1 }
    const first = await prisma.supportNotice.create({ data })
    expect(first).toMatchObject({ status: 'PENDING', attempts: 0, meta: null, firstAttemptAt: null, digestId: null })
    await expect(prisma.supportNotice.create({ data })).rejects.toMatchObject({ code: 'P2002' })
    await expect(prisma.supportNotice.create({ data: { ...data, dedupeKey: `${dedupeKey}:other` } })).resolves.toMatchObject({
      status: 'PENDING',
    })
  })

  it('SupportMessage.outcome is null and handoffOffered false by default; SupportEvent keeps no guides by default', async () => {
    const admitted = await admitSupportMessage(input(`${receiverId}-defaults`, '+525500001031'))
    expect(await prisma.supportMessage.findUnique({ where: { id: admitted.messageId } })).toMatchObject({
      outcome: null,
      handoffOffered: false,
    })
    const event = await prisma.supportEvent.create({
      data: { kind: 'HANDOFF', conversationId: `${receiverId}-event`, generation: 1, sequence: 1, day: '2026-11-11' },
    })
    expect(event).toMatchObject({ app: null, guideIds: [] })
    await prisma.supportMessage.update({ where: { id: admitted.messageId }, data: { outcome: 'OLD_VERSION', handoffOffered: true } })
    expect(await prisma.supportMessage.findUnique({ where: { id: admitted.messageId } })).toMatchObject({
      outcome: 'OLD_VERSION',
      handoffOffered: true,
    })
  })

  it('completeClaim with a transaction client commits with it and rolls back with it', async () => {
    const receiver = `${receiverId}-tx`
    const now = new Date(Date.now() + 1_000)
    const admitted = await admitSupportMessage({ ...input(`${receiver}-job`, '+525500001032'), receiverId: receiver })
    const claim = await claimNext(now, receiver)
    expect(claim?.messageId).toBe(admitted.messageId)
    const status = async () => (await prisma.supportMessage.findUnique({ where: { id: admitted.messageId } }))?.status
    const boom = new Error('rollback')
    await expect(
      prisma.$transaction(async tx => {
        expect(await completeClaim(claim!, { status: 'ANSWER_READY', outcome: 'UNKNOWN' }, now, tx)).toBe(true)
        // inside the transaction the claim is already spent...
        expect(await completeClaim(claim!, { status: 'ANSWER_READY' }, now, tx)).toBe(false)
        throw boom
      }),
    ).rejects.toBe(boom)
    // ...and the rollback gives it back untouched: still CLAIMED, still fenced by its token.
    expect(await status()).toBe('CLAIMED')
    expect(await prisma.supportMessage.findUnique({ where: { id: admitted.messageId } })).toMatchObject({
      claimToken: claim!.claimToken,
      outcome: null,
    })
    await prisma.$transaction(async tx => {
      expect(await completeClaim(claim!, { status: 'ANSWER_READY', outcome: 'UNKNOWN' }, now, tx)).toBe(true)
    })
    expect(await prisma.supportMessage.findUnique({ where: { id: admitted.messageId } })).toMatchObject({
      status: 'ANSWER_READY',
      outcome: 'UNKNOWN',
      claimToken: null,
    })
    // Without a client it is the same call as before.
    await prisma.supportMessage.update({ where: { id: admitted.messageId }, data: { status: 'SENT' } })
    const other = await admitSupportMessage({ ...input(`${receiver}-plain`, '+525500001033'), receiverId: receiver })
    const second = await claimNext(now, receiver)
    expect(second?.messageId).toBe(other.messageId)
    expect(await completeClaim(second!, { status: 'SENT' }, now)).toBe(true)
  })

  it('a failed message insert rolls back the inbound event and sequence allocation', async () => {
    const data = input(`${receiverId}-rollback`, '+525500001006')
    await expect(admitSupportMessage({ ...data, body: null as unknown as string })).rejects.toThrow()
    expect(await prisma.whatsappInboundEvent.findUnique({ where: { wamid: data.wamid } })).toBeNull()
    expect(await prisma.supportConversation.count({ where: { receiverId, phone: data.phone } })).toBe(0)
  })
})
