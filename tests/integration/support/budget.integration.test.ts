import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { LUNA_SUPPORT_PRICING as pricing, maximumSupportCost, getSupportAiConfig } from '@/config/supportWhatsapp'
import { admitSupportMessage, claimNext, completeClaim } from '@/services/support/store.service'
import { reserveAiAttempt, startAiAttempt, finishAiAttempt, releaseUnstartedAiAttempt } from '@/services/support/budget.service'
import { purgeSupportBatch } from '@/services/support/retention.service'
import { resetSupportConversation } from '@/services/support/router.service'
import * as registeredPhone from '@/services/support/registeredPhone.service'

const receiverId = `support-budget-${Date.now()}`
const config = () => getSupportAiConfig()!
beforeAll(() =>
  Object.assign(process.env, {
    SUPPORT_WHATSAPP_ENABLED: 'true',
    SUPPORT_WHATSAPP_PHONE_NUMBER_ID: receiverId,
    WHATSAPP_SALES_PHONE_NUMBER_ID: 'fixture-sales',
    SUPPORT_WHATSAPP_ENC_KEY: 'e'.repeat(64),
    SUPPORT_AI_ENABLED: 'true',
    SUPPORT_AI_MODEL: pricing.model,
    SUPPORT_AI_PRICING_VERSION: pricing.version,
    SUPPORT_OPENAI_API_KEY: 'fixture-never-used',
  }),
)
async function clean() {
  await prisma.supportAttempt.deleteMany({ where: { message: { conversation: { receiverId } } } })
  await prisma.supportMessage.deleteMany({ where: { conversation: { receiverId } } })
  await prisma.supportConversation.deleteMany({ where: { receiverId } })
  await prisma.whatsappInboundEvent.deleteMany({ where: { receiverId } })
  // This integration file owns the entire disposable DB budget namespace.
  await prisma.supportBudget.deleteMany({ where: { key: { startsWith: 'AI:' } } })
}
beforeEach(async () => {
  await clean()
  process.env.SUPPORT_AI_MONTHLY_USD_LIMIT = '100'
})
afterAll(clean)
let serial = 0
async function job(phone = '+525500003001', staffId?: string) {
  const wamid = `${receiverId}-${++serial}`
  const admitted = await admitSupportMessage({
    receiverId,
    wamid,
    phone,
    body: '¿Cómo cobro?',
    type: 'text',
    timestamp: String(Date.now() / 1000),
  })
  await prisma.supportConversation.updateMany({
    where: { receiverId, phone, mode: { not: 'CLOSED' } },
    data: { noticeAcceptedAt: new Date(), app: 'dashboard', lastUserMessageAt: new Date(), ...(staffId ? { staffId } : {}) },
  })
  const claim = (await claimNext(new Date(Date.now() + 1), receiverId))!
  expect(claim.messageId).toBe(admitted.messageId)
  return claim
}
const usage = { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }
it.each(['cancelled', 'closed', 'lease', 'generation', 'off', 'no-coverage'] as const)(
  'releases only an abandoned RESERVED attempt after %s, without waiting thirty days',
  async reason => {
    const claim = await job(),
      attempt = (await reserveAiAttempt(claim, config()))!
    if (reason === 'cancelled') await completeClaim(claim, { status: 'CANCELLED' })
    if (reason === 'closed')
      await prisma.$transaction(async tx =>
        resetSupportConversation(tx, await tx.supportConversation.findUniqueOrThrow({ where: { id: claim.conversationId } }), 'CLOSED'),
      )
    if (reason === 'lease') await prisma.supportMessage.update({ where: { id: claim.messageId }, data: { leaseUntil: new Date(0) } })
    if (reason === 'generation')
      await prisma.supportConversation.update({ where: { id: claim.conversationId }, data: { generation: { increment: 1 } } })
    if (reason === 'off') process.env.SUPPORT_AI_ENABLED = 'false'
    if (reason === 'no-coverage') await completeClaim(claim, { status: 'ANSWER_READY', answer: 'No hay guía.' })
    try {
      await Promise.all([purgeSupportBatch(), purgeSupportBatch()])
      expect((await prisma.supportAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).state).toBe('DEFINITIVE_FAILURE')
      expect((await prisma.supportBudget.findUniqueOrThrow({ where: { key: 'AI:GLOBAL' } })).heldUsd.toString()).toBe('0')
      const keys = (attempt.usage as any).reservation.countKeys as string[]
      for (const key of keys) expect((await prisma.supportBudget.findUniqueOrThrow({ where: { key } })).callCount).toBe(0)
    } finally {
      process.env.SUPPORT_AI_ENABLED = 'true'
    }
  },
)
it('retains a live reservation and every STARTED/UNKNOWN hold, even when its conversation closes', async () => {
  const claim = await job(),
    attempt = (await reserveAiAttempt(claim, config()))!
  await purgeSupportBatch()
  expect((await prisma.supportAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).state).toBe('RESERVED')
  expect(await startAiAttempt(attempt.id, claim)).toBe(true)
  await prisma.$transaction(async tx =>
    resetSupportConversation(tx, await tx.supportConversation.findUniqueOrThrow({ where: { id: claim.conversationId } }), 'CLOSED'),
  )
  await purgeSupportBatch()
  expect((await prisma.supportAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).state).toBe('STARTED')
  expect((await prisma.supportBudget.findUniqueOrThrow({ where: { key: 'AI:GLOBAL' } })).heldUsd).toEqual(maximumSupportCost(pricing))
})
it('competing workers reserve the final global allowance atomically, before any request', async () => {
  const a = await job(),
    b = await job('+525500003002')
  process.env.SUPPORT_AI_MONTHLY_USD_LIMIT = maximumSupportCost(pricing).toString()
  const attempts = await Promise.all([reserveAiAttempt(a, config()), reserveAiAttempt(b, config())])
  expect(attempts.filter(Boolean)).toHaveLength(1)
  expect(attempts.find(Boolean)).toMatchObject({ state: 'RESERVED', reservedUsd: maximumSupportCost(pricing) })
  expect((await prisma.supportBudget.findUniqueOrThrow({ where: { key: 'AI:GLOBAL' } })).heldUsd).toEqual(maximumSupportCost(pricing))
})
it('zero limit or a disabled operator flag refuses even a previously loaded configuration', async () => {
  const claim = await job(),
    cached = config()
  process.env.SUPPORT_AI_MONTHLY_USD_LIMIT = '0'
  expect(await reserveAiAttempt(claim, cached)).toBeNull()
  process.env.SUPPORT_AI_MONTHLY_USD_LIMIT = '100'
  process.env.SUPPORT_AI_ENABLED = 'false'
  expect(await reserveAiAttempt(claim, cached)).toBeNull()
  process.env.SUPPORT_AI_ENABLED = 'true'
  expect(await prisma.supportAttempt.count({ where: { messageId: claim.messageId } })).toBe(0)
})
it('a request is fenced before STARTED; release is idempotent and cannot release uncertain consumption', async () => {
  const claim = await job(),
    attempt = (await reserveAiAttempt(claim, config()))!
  expect(attempt).not.toBeNull()
  expect(await startAiAttempt(attempt.id, claim)).toBe(true)
  expect(await startAiAttempt(attempt.id, claim)).toBe(false)
  await releaseUnstartedAiAttempt(attempt.id)
  expect((await prisma.supportBudget.findUniqueOrThrow({ where: { key: 'AI:GLOBAL' } })).heldUsd).toEqual(maximumSupportCost(pricing))
  await finishAiAttempt(attempt.id, null)
  expect((await prisma.supportAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).state).toBe('UNKNOWN')
  await releaseUnstartedAiAttempt(attempt.id)
  expect((await prisma.supportBudget.findUniqueOrThrow({ where: { key: 'AI:GLOBAL' } })).heldUsd).toEqual(maximumSupportCost(pricing))
})
it('known numeric usage releases the hold once; missing cache detail stays held', async () => {
  const claim = await job(),
    attempt = (await reserveAiAttempt(claim, config()))!
  expect(await startAiAttempt(attempt.id, claim)).toBe(true)
  await finishAiAttempt(attempt.id, usage, 'req_fixture')
  await finishAiAttempt(attempt.id, usage, 'req_fixture')
  expect(await prisma.supportAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toMatchObject({
    state: 'SUCCEEDED',
    actualUsd: new Prisma.Decimal('0.00002'),
  })
  expect((await prisma.supportBudget.findUniqueOrThrow({ where: { key: 'AI:GLOBAL' } })).heldUsd.toString()).toBe('0')
  const month = await prisma.supportBudget.findFirstOrThrow({ where: { key: { startsWith: 'AI:MONTH:' } } })
  expect(month.spentUsd.toString()).toBe('0.00002')
})
it('retains unknown holds across a UTC month boundary', async () => {
  const a = await job(),
    now = new Date('2030-01-31T23:59:59.000Z')
  await prisma.supportConversation.update({ where: { id: a.conversationId }, data: { lastUserMessageAt: now, lastActivityAt: now } })
  await prisma.supportMessage.update({
    where: { id: a.messageId },
    data: { leaseUntil: new Date('2030-02-02T00:00:00.000Z'), expiresAt: new Date('2030-02-28T00:00:00.000Z') },
  })
  const attempt = (await reserveAiAttempt(a, config(), now))!
  expect(await startAiAttempt(attempt.id, a, now)).toBe(true)
  await finishAiAttempt(attempt.id, null, undefined, now)
  const b = await job('+525500003003')
  await prisma.supportMessage.update({
    where: { id: b.messageId },
    data: { leaseUntil: new Date('2030-02-02T00:00:00.000Z'), expiresAt: new Date('2030-02-28T00:00:00.000Z') },
  })
  process.env.SUPPORT_AI_MONTHLY_USD_LIMIT = maximumSupportCost(pricing).toString()
  expect(await reserveAiAttempt(b, config(), new Date('2030-02-01T00:00:01.000Z'))).toBeNull()
})
it.each([
  ['PHONE_HOUR', 10],
  ['PHONE_DAY', 30],
  ['STAFF_DAY', 30],
] as const)('enforces the exact %s limit across phone changes for staff', async (kind, maximum) => {
  const staff = 'c123456789012345678901234',
    first = await job('+525500003004', staff)
  const attempt = (await reserveAiAttempt(first, config()))!
  expect(attempt).not.toBeNull()
  const meta = (attempt.usage as any).reservation
  const key = meta.countKeys.find((v: string) => v.startsWith(`AI:${kind}:`))
  expect(key).toBeDefined()
  await prisma.supportBudget.update({ where: { key }, data: { callCount: maximum - 1 } })
  await completeClaim(first, { status: 'SENT' })
  const phone = kind === 'STAFF_DAY' ? '+525500003005' : '+525500003004'
  const second = await job(phone, staff),
    secondAttempt = await reserveAiAttempt(second, config())
  expect(secondAttempt).not.toBeNull()
  await completeClaim(second, { status: 'SENT' })
  const third = await job(phone, staff)
  expect(await reserveAiAttempt(third, config())).toBeNull()
})
it('releasing a proven unstarted reservation returns its quota once and rejects a stale worker', async () => {
  const claim = await job(),
    attempt = (await reserveAiAttempt(claim, config()))!
  expect(attempt).not.toBeNull()
  await releaseUnstartedAiAttempt(attempt.id)
  await releaseUnstartedAiAttempt(attempt.id)
  expect((await prisma.supportBudget.findUniqueOrThrow({ where: { key: 'AI:GLOBAL' } })).heldUsd.toString()).toBe('0')
  expect(await startAiAttempt(attempt.id, claim)).toBe(false)
  expect(await reserveAiAttempt({ ...claim, claimToken: 'stale-worker' }, config())).toBeNull()
})
describe('hybrid: one attempt per model call', () => {
  const max = maximumSupportCost(pricing)
  const calls = async (keys: string[]) =>
    Promise.all(keys.map(async key => (await prisma.supportBudget.findUniqueOrThrow({ where: { key } })).callCount))
  const held = async () => (await prisma.supportBudget.findUniqueOrThrow({ where: { key: 'AI:GLOBAL' } })).heldUsd.toString()
  const keysOf = (attempt: { usage: unknown }) => (attempt.usage as any).reservation.countKeys as string[]
  async function succeed(claim: Awaited<ReturnType<typeof job>>, call: 1 | 2 | 3) {
    const attempt = (await reserveAiAttempt(claim, config(), new Date(), { call }))!
    expect(attempt).toMatchObject({ state: 'RESERVED', reservedUsd: max })
    expect(await startAiAttempt(attempt.id, claim)).toBe(true)
    await finishAiAttempt(attempt.id, usage)
    return attempt
  }
  beforeEach(() => {
    process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED = 'true'
    process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED = 'true'
    // The fixture phones belong to nobody; registration has its own suite (registeredPhone, worker).
    jest.spyOn(registeredPhone, 'resolveRegisteredSupportPhone').mockResolvedValue({ registered: true, soleStaffId: null })
  })
  afterEach(() => {
    delete process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED
    delete process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED
    jest.restoreAllMocks()
  })
  it('call 2 after a SUCCEEDED call 1 reserves without touching hour/day counters', async () => {
    const claim = await job('+525500003101', 'c223456789012345678901234')
    const first = await succeed(claim, 1)
    expect(keysOf(first)).toHaveLength(3)
    expect(await calls(keysOf(first))).toEqual([1, 1, 1])
    expect(await reserveAiAttempt(claim, config(), new Date(), { call: 3 })).toBeNull()
    const second = (await reserveAiAttempt(claim, config(), new Date(), { call: 2 }))!
    expect(second).toMatchObject({ state: 'RESERVED', ordinal: 2, reservedUsd: max })
    expect(keysOf(second)).toEqual([])
    expect(await calls(keysOf(first))).toEqual([1, 1, 1])
    expect(await held()).toBe(max.toString())
    expect((await reserveAiAttempt(claim, config(), new Date(), { call: 2 }))?.id).toBe(second.id)
    expect(await held()).toBe(max.toString())
  })
  it.each(['STARTED', 'UNKNOWN'] as const)('call 2 is refused after an %s call 1', async state => {
    const claim = await job(),
      first = (await reserveAiAttempt(claim, config(), new Date(), { call: 1 }))!
    expect(await startAiAttempt(first.id, claim)).toBe(true)
    if (state === 'UNKNOWN') await finishAiAttempt(first.id, null)
    expect((await prisma.supportAttempt.findUniqueOrThrow({ where: { id: first.id } })).state).toBe(state)
    expect(await reserveAiAttempt(claim, config(), new Date(), { call: 2 })).toBeNull()
    expect(await prisma.supportAttempt.count({ where: { messageId: claim.messageId } })).toBe(1)
  })
  it('call 4 is refused', async () => {
    const claim = await job()
    await succeed(claim, 1)
    await succeed(claim, 2)
    await succeed(claim, 3)
    expect(await reserveAiAttempt(claim, config(), new Date(), { call: 4 as 3 })).toBeNull()
    expect(await prisma.supportAttempt.count({ where: { messageId: claim.messageId } })).toBe(3)
    expect(await held()).toBe('0')
  })
  it('monthly cap is checked per call', async () => {
    const claim = await job()
    // Room for one settled call (0.00002) plus one more reservation: call 2 fits, call 3 does not.
    process.env.SUPPORT_AI_MONTHLY_USD_LIMIT = max.plus('0.00002').toString()
    await succeed(claim, 1)
    await succeed(claim, 2)
    expect(await reserveAiAttempt(claim, config(), new Date(), { call: 3 })).toBeNull()
    expect(await held()).toBe('0')
  })
  it('releasing or purging an unstarted call 2 does not decrement hour/day counters', async () => {
    const claim = await job(),
      first = await succeed(claim, 1)
    const released = (await reserveAiAttempt(claim, config(), new Date(), { call: 2 }))!
    await releaseUnstartedAiAttempt(released.id)
    expect((await prisma.supportAttempt.findUniqueOrThrow({ where: { id: released.id } })).state).toBe('DEFINITIVE_FAILURE')
    expect(await calls(keysOf(first))).toEqual([1, 1])
    expect(await held()).toBe('0')
    const purged = (await reserveAiAttempt(claim, config(), new Date(), { call: 2 }))!
    expect(purged).toMatchObject({ ordinal: 3 })
    expect(keysOf(purged)).toEqual([])
    await prisma.supportMessage.update({ where: { id: claim.messageId }, data: { leaseUntil: new Date(Date.now() - 1000) } })
    await purgeSupportBatch()
    expect((await prisma.supportAttempt.findUniqueOrThrow({ where: { id: purged.id } })).state).toBe('DEFINITIVE_FAILURE')
    expect(await calls(keysOf(first))).toEqual([1, 1])
    expect(await held()).toBe('0')
  })
  it('startAiAttempt with verify returning false does not start; verify runs after the lock is taken', async () => {
    const claim = await job(),
      attempt = (await reserveAiAttempt(claim, config(), new Date(), { call: 1 }))!
    let locked!: () => void, release!: () => void
    const taken = new Promise<void>(resolve => (locked = resolve)),
      go = new Promise<void>(resolve => (release = resolve))
    const holder = prisma.$transaction(
      async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('support-ai-budget', 0))`
        locked()
        await go
        // Committed together with the lock release: only a verify that runs after the lock can see it.
        await tx.supportConversation.update({ where: { id: claim.conversationId }, data: { appVersion: 'changed-while-waiting' } })
      },
      { timeout: 20_000 },
    )
    await taken
    const seen: (string | null)[] = []
    const started = startAiAttempt(attempt.id, claim, new Date(), {
      verify: async tx => {
        const { appVersion } = await tx.supportConversation.findUniqueOrThrow({ where: { id: claim.conversationId } })
        seen.push(appVersion)
        return appVersion !== 'changed-while-waiting'
      },
    })
    for (let i = 0; ; i++) {
      const [row] = await prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND wait_event = 'advisory' AND query LIKE '%support-ai-budget%'`
      if (row.n > 0) break
      if (i > 100) throw new Error('startAiAttempt never waited for the budget lock')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    expect(seen).toEqual([])
    release()
    await holder
    expect(await started).toBe(false)
    expect(seen).toEqual(['changed-while-waiting'])
    expect(await prisma.supportAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toMatchObject({
      state: 'RESERVED',
      startedAt: null,
    })
    expect(await startAiAttempt(attempt.id, claim, new Date(), { verify: async () => true })).toBe(true)
    expect((await prisma.supportAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).state).toBe('STARTED')
  })
  it.each(['purge', 'reclaim'] as const)(
    'call 1 reserved → worker dies → cleanup (%s) → new claim → call 1 again: one question counted',
    async cleanup => {
      const dead = await job(),
        first = (await reserveAiAttempt(dead, config(), new Date(), { call: 1 }))!
      expect(await calls(keysOf(first))).toEqual([1, 1])
      await prisma.supportMessage.update({ where: { id: dead.messageId }, data: { leaseUntil: new Date(Date.now() - 1000) } })
      if (cleanup === 'purge') await purgeSupportBatch()
      const fresh = (await claimNext(new Date(Date.now() + 1), receiverId))!
      expect(fresh).toMatchObject({ messageId: dead.messageId })
      expect(fresh.claimToken).not.toBe(dead.claimToken)
      const again = (await reserveAiAttempt(fresh, config(), new Date(), { call: 1 }))!
      expect(again).toMatchObject({ state: 'RESERVED', ordinal: 2 })
      expect(keysOf(again)).toEqual(keysOf(first))
      expect((await prisma.supportAttempt.findUniqueOrThrow({ where: { id: first.id } })).state).toBe('DEFINITIVE_FAILURE')
      expect(await calls(keysOf(first))).toEqual([1, 1])
      expect(await held()).toBe(max.toString())
    },
  )
  it.each(['hybrid off', 'free text off', 'no call option'] as const)('flag off: a second attempt is refused as today (%s)', async mode => {
    if (mode === 'hybrid off') delete process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED
    if (mode === 'free text off') delete process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED
    const options = mode === 'no call option' ? undefined : ({ call: 1 } as const)
    const claim = await job(),
      first = (await reserveAiAttempt(claim, config(), new Date(), options))!
    expect(keysOf(first)).toHaveLength(2)
    expect(await startAiAttempt(first.id, claim)).toBe(true)
    await finishAiAttempt(first.id, usage)
    expect(await reserveAiAttempt(claim, config(), new Date(), mode === 'no call option' ? undefined : { call: 2 })).toBeNull()
    expect(await calls(keysOf(first))).toEqual([1, 1])
    expect(await prisma.supportAttempt.count({ where: { messageId: claim.messageId } })).toBe(1)
  })
})
