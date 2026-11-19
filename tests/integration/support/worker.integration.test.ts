import crypto from 'crypto'
import prisma from '@/utils/prismaClient'
import { LUNA_SUPPORT_PRICING as pricing, getSupportAiConfig, maximumSupportCost } from '@/config/supportWhatsapp'
import { admitSupportMessage, claimNext, completeClaim } from '@/services/support/store.service'
import { prepareSupportAnswer, SUPPORT_AI_UNCERTAIN } from '@/services/support/worker.service'
import { reserveAiAttempt, startAiAttempt, finishAiAttempt } from '@/services/support/budget.service'
import * as budget from '@/services/support/budget.service'
import * as registeredPhone from '@/services/support/registeredPhone.service'
import { SUPPORT_SEND_RETRY_NOTICE, SUPPORT_UNREGISTERED } from '@/services/support/texts'
import { tryRouteSupport } from '@/services/support/router.service'
import { createSupportAiClient } from '@/services/support/answer.service'
import type { VerifiedSection } from '@/services/support/knowledge.service'
import { deliverSupportMessage } from '@/services/support/delivery.service'
import { Prisma } from '@prisma/client'
import { readSupportContext } from '@/services/support/context.service'
const receiverId = `support-worker-${Date.now()}`,
  phone = '+525500007001'
const guide: VerifiedSection = {
  id: 'dashboard/menu/gestionar-productos',
  app: 'dashboard',
  title: 'Crear productos',
  summary: 'Resumen verificado de prueba',
  steps: ['Paso uno verificado', 'Último paso verificado'],
  // T-F6 (H3): a verified section's steps only go out with its whole guide.
  whole: '*Pasos*\n\n1. Paso uno verificado\n2. Último paso verificado',
  publicUrl: 'https://avoqado.io/help/dashboard/menu/gestionar-productos',
  keywords: ['productos'],
  requiredPermissions: [],
}
let serial = 0
let selectorStaffId: string, selectorOrgId: string, selectorVenueId: string
const originalFetch = global.fetch
afterEach(() => {
  global.fetch = originalFetch
})
const input = (body: string) => ({
  receiverId,
  phone,
  wamid: `${receiverId}-${++serial}`,
  type: 'text',
  body,
  timestamp: String(Math.floor(Date.now() / 1000)),
})
function provider(callback?: () => Promise<void>, fail = false) {
  const fetcher = jest.fn(async () => {
    await callback?.()
    if (fail) throw new TypeError('fixture lost response')
    return new Response(
      JSON.stringify({
        id: 'resp_fixture',
        status: 'completed',
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          untrusted: 'DATO_QUE_NO_DEBE_GUARDARSE',
        },
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: JSON.stringify({ sectionIds: [guide.id], needsClarification: false }), annotations: [] },
            ],
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  })
  return { fetcher, client: createSupportAiClient(getSupportAiConfig()!, fetcher as unknown as typeof fetch), sections: [guide] }
}
async function clean() {
  await prisma.supportAttempt.deleteMany({ where: { message: { conversation: { receiverId } } } })
  await prisma.supportMessage.deleteMany({ where: { conversation: { receiverId } } })
  await prisma.supportConversation.deleteMany({ where: { receiverId } })
  await prisma.whatsappInboundEvent.deleteMany({ where: { receiverId } })
  await prisma.supportBudget.deleteMany({
    where: { OR: [{ key: { startsWith: 'AI:' } }, { key: { startsWith: `CONTROL:${receiverId}:` } }] },
  })
}
beforeAll(async () => {
  Object.assign(process.env, {
    SUPPORT_WHATSAPP_ENABLED: 'true',
    SUPPORT_WHATSAPP_PHONE_NUMBER_ID: receiverId,
    WHATSAPP_SALES_PHONE_NUMBER_ID: 'sales',
    SUPPORT_WHATSAPP_ENC_KEY: 'e'.repeat(64),
    SUPPORT_AI_ENABLED: 'true',
    SUPPORT_AI_MODEL: pricing.model,
    SUPPORT_AI_PRICING_VERSION: pricing.version,
    SUPPORT_AI_MONTHLY_USD_LIMIT: '10',
    SUPPORT_OPENAI_API_KEY: 'fixture-never-used',
    WHATSAPP_ACCESS_TOKEN: 'fixture-never-used',
  })
  const org = await prisma.organization.create({
    data: { name: 'Selector support fixture', email: `${receiverId}-org@test.local`, phone: '0000000000' },
  })
  selectorOrgId = org.id
  const venue = await prisma.venue.create({
    data: { organizationId: org.id, name: 'Sucursal fixture', slug: `${receiverId}-selector`, status: 'ACTIVE' },
  })
  selectorVenueId = venue.id
  const staff = await prisma.staff.create({
    data: { email: `${receiverId}-staff@test.local`, firstName: 'Selector', lastName: 'Prueba', emailVerified: true },
  })
  selectorStaffId = staff.id
  await prisma.staffOrganization.create({ data: { staffId: staff.id, organizationId: org.id, role: 'MEMBER' } })
  await prisma.staffVenue.create({ data: { staffId: staff.id, venueId: venue.id, role: 'VIEWER' } })
})
beforeEach(clean)
afterAll(async () => {
  await clean()
  if (!selectorStaffId || !selectorVenueId || !selectorOrgId) return
  await prisma.supportWhatsappLink.deleteMany({ where: { staffId: selectorStaffId } })
  await prisma.staffVenue.deleteMany({ where: { staffId: selectorStaffId } })
  await prisma.staffOrganization.deleteMany({ where: { staffId: selectorStaffId } })
  await prisma.venue.delete({ where: { id: selectorVenueId } })
  await prisma.organization.delete({ where: { id: selectorOrgId } })
  await prisma.staff.delete({ where: { id: selectorStaffId } })
})
async function enqueue(body = 'Crear productos') {
  const admitted = await admitSupportMessage(input(body))
  await prisma.supportConversation.updateMany({
    where: { receiverId, phone, mode: { not: 'CLOSED' } },
    data: { noticeAcceptedAt: new Date(), app: 'dashboard', lastUserMessageAt: new Date(), lastActivityAt: new Date() },
  })
  return admitted.messageId
}
const claim = () => claimNext(new Date(Date.now() + 10), receiverId)
it.each(['NOTICE', 'APP', 'VENUE', 'VERSION', 'DEVICE'] as const)(
  'REINTENTAR recovers an uncertain %s control without consuming the selector or invoking AI',
  async pending => {
    const first = await enqueue('AYUDA')
    const original = await prisma.supportMessage.findUniqueOrThrow({ where: { id: first } })
    await prisma.supportConversation.update({
      where: { id: original.conversationId },
      data: {
        app: ['NOTICE', 'APP'].includes(pending) ? null : 'tpv',
        noticeAcceptedAt: pending === 'NOTICE' ? null : new Date(),
        pendingSelection: pending === 'NOTICE' ? null : pending,
        selectionOptions:
          pending === 'NOTICE'
            ? Prisma.DbNull
            : pending === 'VERSION'
              ? { items: [], topic: 'Tema sintético' }
              : { items: [{ value: pending === 'APP' ? 'dashboard' : 'PAX', label: pending === 'APP' ? 'Dashboard web' : 'PAX' }] },
        selectionExpiresAt: new Date(Date.now() + 600000),
      },
    })
    if (pending === 'VENUE') {
      const link = await prisma.supportWhatsappLink.create({
        data: { staffId: selectorStaffId, phone, expiresAt: new Date(Date.now() + 86400000) },
      })
      await prisma.supportConversation.update({
        where: { id: original.conversationId },
        data: {
          mode: 'PERSONAL',
          staffId: selectorStaffId,
          linkId: link.id,
          selectionOptions: {
            items: [{ value: selectorVenueId, orgId: selectorOrgId, label: 'Sucursal fixture' }],
            nextCursor: null,
            cursor: null,
            search: '',
          },
        },
      })
    }
    await prisma.supportMessage.update({
      where: { id: first },
      data: {
        status: 'SEND_UNKNOWN',
        answer: 'Respuesta de control completa y guardada.',
        accessFingerprint: (
          await readSupportContext(await prisma.supportConversation.findUniqueOrThrow({ where: { id: original.conversationId } }))
        ).fingerprint,
      },
    })
    await prisma.supportAttempt.create({
      data: { messageId: first, kind: 'SEND', ordinal: 1, claimToken: 'fixture', state: 'UNKNOWN', pricingVersion: 'whatsapp-service-v1' },
    })
    const event = input('REINTENTAR')
    expect(await tryRouteSupport(event)).toBe('QUEUED')
    const message = await prisma.supportMessage.findFirstOrThrow({ where: { inboundEvent: { wamid: event.wamid } } })
    expect(message).toMatchObject({ body: 'REINTENTAR', status: 'QUEUED', answer: null })
    const p = provider()
    expect(await prepareSupportAnswer((await claim())!, p)).toBe('READY')
    expect(await prisma.supportMessage.findUniqueOrThrow({ where: { id: message.id } })).toMatchObject({
      retryOfId: first,
      answer: expect.stringContaining('Respuesta de control completa y guardada.'),
    })
    expect(p.fetcher).not.toHaveBeenCalled()
    expect((await prisma.supportConversation.findUniqueOrThrow({ where: { id: original.conversationId } })).pendingSelection).toBe(
      pending === 'NOTICE' ? null : pending,
    )
    global.fetch = jest.fn(
      async () => new Response(JSON.stringify({ messages: [{ id: `wamid.control-retry-${pending}` }] }), { status: 200 }),
    ) as typeof fetch
    expect(await deliverSupportMessage((await claim())!, p.sections)).toBe('SENT')
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String((global.fetch as jest.Mock).mock.calls[0][1].body)).text.body).toContain(
      'El primer mensaje pudo haber llegado',
    )
    await tryRouteSupport(input('REINTENTAR'))
    const second = (await claim())!
    expect(await prepareSupportAnswer(second, p)).toBe('READY')
    expect((await prisma.supportMessage.findUniqueOrThrow({ where: { id: second.messageId } })).answer).toContain(
      'Se permite un solo reintento',
    )
    expect(p.fetcher).not.toHaveBeenCalled()
  },
)
it.each([
  ['VERSION', 'DEVICE', 'segunda'],
  ['DEVICE', 'VERSION', 'segunda'],
  ['VERSION', 'VERSION', 'otro tema'],
  ['DEVICE', 'DEVICE', 'otro tema'],
  ['APP', 'APP', 'otras opciones'],
] as const)('does not replay a superseded %s control as the current %s selector (%s)', async (before, after, topic) => {
  const first = await enqueue('primera pregunta'),
    original = await prisma.supportMessage.findUniqueOrThrow({ where: { id: first } })
  const options = (kind: string, value: string) => ({
    items: kind === 'VERSION' ? [] : [{ value: kind === 'APP' ? 'dashboard' : 'PAX', label: value }],
    topic: value,
  })
  await prisma.supportConversation.update({
    where: { id: original.conversationId },
    data: {
      app: before === 'APP' ? null : 'tpv',
      pendingSelection: before,
      selectionOptions: options(before, 'primera'),
      selectionExpiresAt: new Date(Date.now() + 600000),
    },
  })
  await prisma.supportMessage.update({ where: { id: first }, data: { status: 'ANSWER_READY', answer: 'OLD_CONTROL_SHOULD_NOT_REAPPEAR' } })
  global.fetch = jest.fn(async () => {
    throw new TypeError('fixture lost ACK')
  }) as typeof fetch
  expect(await deliverSupportMessage((await claim())!)).toBe('UNKNOWN')
  const second = await enqueue('segunda pregunta')
  await prisma.supportMessage.update({ where: { id: second }, data: { status: 'SENT', answer: 'Current control.' } })
  await prisma.supportConversation.update({
    where: { id: original.conversationId },
    data: {
      app: after === 'APP' ? null : 'tpv',
      pendingSelection: after,
      selectionOptions: options(after, topic),
      selectionExpiresAt: new Date(Date.now() + 600000),
    },
  })
  const retryEvent = input('REINTENTAR')
  await tryRouteSupport(retryEvent)
  const retry = await prisma.supportMessage.findFirstOrThrow({ where: { inboundEvent: { wamid: retryEvent.wamid } } })
  const p = provider()
  await prepareSupportAnswer((await claim())!, p)
  const saved = await prisma.supportMessage.findUniqueOrThrow({ where: { id: retry.id } })
  expect(saved.answer).not.toContain('OLD_CONTROL_SHOULD_NOT_REAPPEAR')
  expect(saved.answer).toContain('AYUDA')
  expect(p.fetcher).not.toHaveBeenCalled()
})
async function sent(id: string) {
  await prisma.supportMessage.update({ where: { id }, data: { status: 'SENT' } })
}
it('persists reservation and STARTED before the fake provider, and saves the complete answer before delivery', async () => {
  const id = await enqueue(),
    job = (await claim())!
  const p = provider(async () => {
    const attempt = await prisma.supportAttempt.findFirstOrThrow({ where: { messageId: id } })
    expect(attempt.state).toBe('STARTED')
    expect(attempt.reservedUsd).toEqual(maximumSupportCost(pricing))
    expect((await prisma.supportMessage.findUniqueOrThrow({ where: { id } })).answer).toBeNull()
  })
  expect(await prepareSupportAnswer(job, p)).toBe('READY')
  expect(p.fetcher).toHaveBeenCalledTimes(1)
  expect(await prisma.supportMessage.findUniqueOrThrow({ where: { id } })).toMatchObject({
    status: 'ANSWER_READY',
    sourceIds: [guide.id],
    answer: expect.stringContaining(guide.steps[1]),
  })
  const attempt = await prisma.supportAttempt.findFirstOrThrow({ where: { messageId: id } })
  expect(attempt.state).toBe('SUCCEEDED')
  expect(JSON.stringify(attempt.usage)).not.toContain('DATO_QUE_NO_DEBE_GUARDARSE')
})
it('two consecutive questions remain FIFO until the saved answer has actually finished', async () => {
  const first = await enqueue()
  const second = await enqueue()
  const job = (await claim())!,
    p = provider()
  expect(job.messageId).toBe(first)
  await prepareSupportAnswer(job, p)
  const again = (await claim())!
  expect(again.messageId).toBe(first)
  await completeClaim(again, { status: 'SENT' })
  expect((await claim())?.messageId).toBe(second)
  expect(p.fetcher).toHaveBeenCalledTimes(1)
})
it('unknown AI gets one persisted fallback; reclaiming that answer never calls AI again', async () => {
  const id = await enqueue(),
    job = (await claim())!,
    p = provider(undefined, true)
  expect(await prepareSupportAnswer(job, p)).toBe('UNKNOWN')
  expect(await prisma.supportAttempt.findFirstOrThrow({ where: { messageId: id } })).toMatchObject({ state: 'UNKNOWN' })
  expect((await prisma.supportBudget.findUniqueOrThrow({ where: { key: 'AI:GLOBAL' } })).heldUsd).toEqual(maximumSupportCost(pricing))
  await prepareSupportAnswer((await claim())!, p)
  expect(p.fetcher).toHaveBeenCalledTimes(1)
})
it('SALIR during the provider request prevents late answers from reviving the closed conversation', async () => {
  const id = await enqueue(),
    job = (await claim())!,
    p = provider(async () => {
      await tryRouteSupport(input('SALIR'))
    })
  expect(await prepareSupportAnswer(job, p)).toBe('CANCELLED')
  expect(await prisma.supportMessage.findUniqueOrThrow({ where: { id } })).toMatchObject({
    status: 'CANCELLED',
    answer: null,
    body: '',
    sourceIds: [],
  })
  expect(await prisma.supportConversation.findUniqueOrThrow({ where: { id: job.conversationId } })).toMatchObject({ mode: 'CLOSED' })
  expect((await prisma.supportAttempt.findFirstOrThrow({ where: { messageId: id } })).state).toBe('SUCCEEDED')
})
it('permits one explicit retry of the last unknown AI and does not permit a chain of retries', async () => {
  const first = await enqueue(),
    p = provider(undefined, true)
  await prepareSupportAnswer((await claim())!, p)
  await sent(first)
  const retry = await enqueue('REINTENTAR')
  await prepareSupportAnswer((await claim())!, p)
  await sent(retry)
  expect(await prisma.supportMessage.findUniqueOrThrow({ where: { id: retry } })).toMatchObject({ retryOfId: first })
  expect(p.fetcher).toHaveBeenCalledTimes(2)
  await enqueue('REINTENTAR')
  await prepareSupportAnswer((await claim())!, p)
  expect(p.fetcher).toHaveBeenCalledTimes(2)
})
it.each([
  'finish-before-recovery',
  'finish-after-recovery',
  'finish-after-fallback',
  'unknown-usage',
  'concurrent-finish-recovery',
] as const)('lost-result matrix %s keeps accounting and one retry after the fallback is sent', async order => {
  const first = await enqueue(),
    original = (await claim())!
  const attempt = (await reserveAiAttempt(original, getSupportAiConfig()!))!
  expect(await startAiAttempt(attempt.id, original)).toBe(true)
  const usage = { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }
  if (order === 'finish-before-recovery' || order === 'unknown-usage')
    await finishAiAttempt(attempt.id, order === 'unknown-usage' ? null : usage)
  if (order === 'concurrent-finish-recovery')
    await Promise.all([finishAiAttempt(attempt.id, usage), claimNext(new Date(Date.now() + 91000), receiverId)])
  else expect(await claimNext(new Date(Date.now() + 91000), receiverId)).toBeNull()
  if (order === 'finish-after-recovery') await finishAiAttempt(attempt.id, usage)
  await prisma.supportMessage.update({ where: { id: first }, data: { answer: SUPPORT_AI_UNCERTAIN, status: 'SENT' } })
  if (order === 'finish-after-fallback') await finishAiAttempt(attempt.id, usage)
  const settled = await prisma.supportAttempt.findUniqueOrThrow({ where: { id: attempt.id } })
  expect(settled.state).toBe(order === 'unknown-usage' ? 'UNKNOWN' : 'SUCCEEDED')
  expect(settled.actualUsd?.toString() ?? null).toBe(order === 'unknown-usage' ? null : '0.00002')
  expect(settled.usage).toMatchObject({ resultUnavailable: true })
  const retry = await enqueue('REINTENTAR'),
    p = provider()
  expect(await prepareSupportAnswer((await claim())!, p)).toBe('READY')
  expect(p.fetcher).toHaveBeenCalledTimes(1)
  expect(await prisma.supportMessage.findUniqueOrThrow({ where: { id: retry } })).toMatchObject({ retryOfId: first })
  await sent(retry)
  await enqueue('REINTENTAR')
  await prepareSupportAnswer((await claim())!, p)
  expect(p.fetcher).toHaveBeenCalledTimes(1)
  expect((await prisma.supportAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).actualUsd?.toString() ?? null).toBe(
    order === 'unknown-usage' ? null : '0.00002',
  )
  expect((await prisma.supportBudget.findUniqueOrThrow({ where: { key: 'AI:GLOBAL' } })).heldUsd.toString()).toBe(
    order === 'unknown-usage' ? maximumSupportCost(pricing).toString() : '0',
  )
})
it.each([
  ['AI-2', ['SUCCEEDED', 'UNKNOWN']],
  ['AI-3', ['SUCCEEDED', 'SUCCEEDED', 'UNKNOWN']],
] as const)('REINTENTAR takes the resend branch when SEND is UNKNOWN with %s UNKNOWN', async (_label, states) => {
  const first = await enqueue(),
    original = await prisma.supportMessage.findUniqueOrThrow({ where: { id: first } })
  const answer = 'Respuesta redactada completa y guardada.'
  await prisma.supportMessage.update({
    where: { id: first },
    data: {
      status: 'SEND_UNKNOWN',
      answer,
      sourceIds: [guide.id],
      accessFingerprint: (
        await readSupportContext(await prisma.supportConversation.findUniqueOrThrow({ where: { id: original.conversationId } }))
      ).fingerprint,
    },
  })
  // SEND keeps ordinal 1, so up to three AI calls on the same message outrank it in any ordinal-ordered take.
  await prisma.supportAttempt.createMany({
    data: [
      { messageId: first, kind: 'SEND', ordinal: 1, claimToken: 'fixture', state: 'UNKNOWN', pricingVersion: 'whatsapp-service-v1' },
      ...states.map((state, i) => ({
        messageId: first,
        kind: 'AI' as const,
        ordinal: i + 1,
        claimToken: 'fixture',
        state,
        pricingVersion: pricing.version,
      })),
    ],
  })
  const retry = await enqueue('REINTENTAR'),
    p = provider()
  expect(await prepareSupportAnswer((await claim())!, p)).toBe('READY')
  expect(p.fetcher).not.toHaveBeenCalled()
  expect(await prisma.supportMessage.findUniqueOrThrow({ where: { id: retry } })).toMatchObject({
    retryOfId: first,
    answer: `${SUPPORT_SEND_RETRY_NOTICE}\n\n${answer}`,
    sourceIds: [guide.id],
  })
  expect(await prisma.supportAttempt.count({ where: { messageId: retry } })).toBe(0)
})
describe('registration checks (SUPPORT_WHATSAPP_FREE_TEXT_ENABLED)', () => {
  beforeEach(async () => {
    process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED = 'true'
    // Earlier cases leave a personal link for this phone, which would register it.
    await prisma.supportWhatsappLink.deleteMany({ where: { staffId: selectorStaffId } })
  })
  afterEach(async () => {
    delete process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED
    jest.restoreAllMocks()
    await prisma.staff.update({ where: { id: selectorStaffId }, data: { phone: null } })
  })
  it.each([
    ['a guide', 'dashboard', guide],
    ['a terminal choice', 'tpv', { ...guide, id: 'tpv/cobros/cobrar', app: 'tpv', deviceFamily: 'PAX' }],
    ['a version', 'android', { ...guide, id: 'android/cobros/cobrar', app: 'android', versionMin: '2.0.0' }],
  ] as const)('a queued question from a phone no longer registered gets the fixed message instead of %s', async (_label, app, section) => {
    const id = await enqueue()
    await prisma.supportConversation.updateMany({ where: { receiverId, phone, mode: { not: 'CLOSED' } }, data: { app } })
    const p = provider()
    expect(await prepareSupportAnswer((await claim())!, { client: p.client, sections: [section as VerifiedSection] })).toBe('READY')
    expect(await prisma.supportMessage.findUniqueOrThrow({ where: { id } })).toMatchObject({ answer: SUPPORT_UNREGISTERED })
    expect(await prisma.supportConversation.findFirstOrThrow({ where: { receiverId, phone } })).toMatchObject({ pendingSelection: null })
    expect(await prisma.supportAttempt.count({ where: { messageId: id } })).toBe(0)
    expect(p.fetcher).not.toHaveBeenCalled()
  })
  it.each(['also', 'moves'])('a personal answer for A whose phone %s to B is prepared as public help', async kind => {
    await prisma.staff.update({ where: { id: selectorStaffId }, data: { phone } })
    const other = await prisma.staff.create({
      data: { email: `${receiverId}-other-${kind}@test.local`, firstName: 'Otra', lastName: 'Cuenta', phone },
    })
    try {
      await prisma.staffVenue.create({ data: { staffId: other.id, venueId: selectorVenueId, role: 'VIEWER' } })
      const link = await prisma.supportWhatsappLink.create({
        data: { staffId: selectorStaffId, phone, verifiedAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 86400000) },
      })
      const id = await enqueue()
      await prisma.supportConversation.updateMany({
        where: { receiverId, phone, mode: { not: 'CLOSED' } },
        data: { mode: 'PERSONAL', staffId: selectorStaffId, linkId: link.id, orgId: selectorOrgId, venueId: selectorVenueId },
      })
      if (kind === 'moves') await prisma.staff.update({ where: { id: selectorStaffId }, data: { phone: null } })
      const p = provider()
      expect(await prepareSupportAnswer((await claim())!, p)).toBe('CANCELLED')
      expect(p.fetcher).not.toHaveBeenCalled()
      expect((await prisma.supportMessage.findUniqueOrThrow({ where: { id } })).answer).toMatch(/^Tu acceso cambió/)
      expect(await prisma.supportConversation.findFirstOrThrow({ where: { receiverId, phone } })).toMatchObject({
        mode: 'PUBLIC',
        staffId: null,
        venueId: null,
      })
    } finally {
      await prisma.supportWhatsappLink.deleteMany({ where: { staffId: selectorStaffId } })
      await prisma.staffVenue.deleteMany({ where: { staffId: other.id } })
      await prisma.staff.delete({ where: { id: other.id } })
    }
  })
  it('a personal question whose phone is saved on a second account before startAiAttempt never reaches the provider', async () => {
    await prisma.staff.update({ where: { id: selectorStaffId }, data: { phone } })
    const other = await prisma.staff.create({
      data: { email: `${receiverId}-late-other@test.local`, firstName: 'Otra', lastName: 'Cuenta' },
    })
    try {
      await prisma.staffVenue.create({ data: { staffId: other.id, venueId: selectorVenueId, role: 'VIEWER' } })
      const link = await prisma.supportWhatsappLink.create({
        data: { staffId: selectorStaffId, phone, verifiedAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 86400000) },
      })
      const id = await enqueue()
      await prisma.supportConversation.updateMany({
        where: { receiverId, phone, mode: { not: 'CLOSED' } },
        data: { mode: 'PERSONAL', staffId: selectorStaffId, linkId: link.id, orgId: selectorOrgId, venueId: selectorVenueId },
      })
      const real = budget.startAiAttempt
      jest.spyOn(budget, 'startAiAttempt').mockImplementationOnce(async (...args: Parameters<typeof real>) => {
        await prisma.staff.update({ where: { id: other.id }, data: { phone } })
        return real(...args)
      })
      const p = provider()
      expect(await prepareSupportAnswer((await claim())!, p)).toBe('CANCELLED')
      expect(p.fetcher).not.toHaveBeenCalled()
      expect((await prisma.supportMessage.findUniqueOrThrow({ where: { id } })).answer).toMatch(/^Tu acceso cambió/)
      expect(await prisma.supportAttempt.findFirstOrThrow({ where: { messageId: id } })).toMatchObject({ state: 'DEFINITIVE_FAILURE' })
    } finally {
      await prisma.supportWhatsappLink.deleteMany({ where: { staffId: selectorStaffId } })
      await prisma.staffVenue.deleteMany({ where: { staffId: other.id } })
      await prisma.staff.delete({ where: { id: other.id } })
    }
  })
  it('two queued questions of a phone no longer registered get a single fixed message today', async () => {
    await prisma.staff.update({ where: { id: selectorStaffId }, data: { phone } })
    const first = await enqueue(),
      second = await enqueue('Otra pregunta')
    await prisma.staff.update({ where: { id: selectorStaffId }, data: { phone: null } })
    const p = provider()
    expect(await prepareSupportAnswer((await claim())!, p)).toBe('READY')
    await sent(first)
    expect(await prepareSupportAnswer((await claim())!, p)).toBe('CANCELLED')
    expect(await prisma.supportMessage.findUniqueOrThrow({ where: { id: first } })).toMatchObject({ answer: SUPPORT_UNREGISTERED })
    expect(await prisma.supportMessage.findUniqueOrThrow({ where: { id: second } })).toMatchObject({ status: 'CANCELLED', answer: null })
    expect(p.fetcher).not.toHaveBeenCalled()
  })
  it('a fixed message the router already sent today means the worker sends none', async () => {
    const id = await enqueue()
    const now = new Date(),
      day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    const key = `CONTROL:${receiverId}:${crypto.createHash('sha256').update(phone).digest('hex')}:STATIC:${day.toISOString()}`
    await prisma.supportBudget.create({ data: { key, windowStart: day, callCount: 1 } })
    expect(await prepareSupportAnswer((await claim())!, provider())).toBe('CANCELLED')
    expect(await prisma.supportMessage.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'CANCELLED', answer: null })
  })
  it('a fixed message whose save is lost spends no daily cap, so the recovered question still gets it', async () => {
    const id = await enqueue()
    const real = registeredPhone.resolveRegisteredSupportPhone
    jest.spyOn(registeredPhone, 'resolveRegisteredSupportPhone').mockImplementationOnce(async (...args: Parameters<typeof real>) => {
      // The lease is lost between the first read and the save of the fixed message.
      await prisma.supportMessage.update({ where: { id }, data: { claimToken: 'taken-over' } })
      return real(...args)
    })
    expect(await prepareSupportAnswer((await claim())!, provider())).toBe('CANCELLED')
    expect(await prisma.supportBudget.count({ where: { key: { startsWith: `CONTROL:${receiverId}:`, contains: ':STATIC:' } } })).toBe(0)
    // Lease recovery puts the question back in the queue.
    await prisma.supportMessage.update({ where: { id }, data: { status: 'QUEUED', claimToken: null, leaseUntil: null } })
    expect(await prepareSupportAnswer((await claim())!, provider())).toBe('READY')
    expect(await prisma.supportMessage.findUniqueOrThrow({ where: { id } })).toMatchObject({ answer: SUPPORT_UNREGISTERED })
  })
  it('a public answer still being prepared when the person links never cancels the new personal question', async () => {
    await prisma.staff.update({ where: { id: selectorStaffId }, data: { phone } })
    try {
      const oldId = await enqueue()
      const conversationId = (await prisma.supportMessage.findUniqueOrThrow({ where: { id: oldId } })).conversationId
      let nextWamid = ''
      const p = provider(async () => {
        // Linked in the panel while this public answer was being prepared, then a new question.
        await prisma.supportWhatsappLink.create({
          data: { staffId: selectorStaffId, phone, verifiedAt: new Date(), expiresAt: new Date(Date.now() + 86400000) },
        })
        await prisma.supportLinkChallenge.create({
          data: {
            staffId: selectorStaffId,
            phone,
            conversationId,
            operationKey: 'linked-while-preparing',
            codeHash: '',
            expiresAt: new Date(Date.now() + 600_000),
            consumedAt: new Date(),
          },
        })
        const next = input('¿Y para facturar?')
        nextWamid = next.wamid
        expect(await tryRouteSupport(next)).toBe('QUEUED')
      })
      expect(await prepareSupportAnswer((await claim())!, p)).toBe('CANCELLED')
      expect(p.fetcher).toHaveBeenCalledTimes(1)
      const conversation = await prisma.supportConversation.findUniqueOrThrow({ where: { id: conversationId } })
      expect(conversation).toMatchObject({
        mode: 'PERSONAL',
        staffId: selectorStaffId,
        venueId: selectorVenueId,
        app: 'dashboard',
        noticeAcceptedAt: expect.any(Date),
      })
      expect(await prisma.supportMessage.findFirstOrThrow({ where: { inboundEvent: { wamid: nextWamid } } })).toMatchObject({
        status: 'QUEUED',
        body: '¿Y para facturar?',
        generation: conversation.generation,
      })
      expect(await prisma.supportMessage.findUniqueOrThrow({ where: { id: oldId } })).toMatchObject({ status: 'CANCELLED' })
    } finally {
      await prisma.supportLinkChallenge.deleteMany({ where: { staffId: selectorStaffId } })
      await prisma.supportWhatsappLink.deleteMany({ where: { staffId: selectorStaffId } })
    }
  })
  it('registration withdrawn while startAiAttempt waits for its lock releases the reservation and never calls the provider', async () => {
    await prisma.staff.update({ where: { id: selectorStaffId }, data: { phone } })
    const id = await enqueue()
    const real = budget.startAiAttempt
    const spy = jest.spyOn(budget, 'startAiAttempt').mockImplementationOnce(async (...args: Parameters<typeof real>) => {
      let locked!: () => void, withdraw!: () => void
      const held = new Promise<void>(resolve => (locked = resolve)),
        go = new Promise<void>(resolve => (withdraw = resolve))
      const holder = prisma.$transaction(
        async tx => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('support-ai-budget', 0))`
          locked()
          await go
          await tx.staff.update({ where: { id: selectorStaffId }, data: { phone: null } })
        },
        { timeout: 20_000 },
      )
      await held
      const started = real(...args)
      for (let i = 0; ; i++) {
        const [row] = await prisma.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND wait_event = 'advisory' AND query LIKE '%support-ai-budget%'`
        if (row.n > 0) break
        if (i > 100) throw new Error('startAiAttempt never waited for the budget lock')
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      withdraw()
      await holder
      return started
    })
    const p = provider()
    expect(await prepareSupportAnswer((await claim())!, p)).toBe('READY')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(p.fetcher).not.toHaveBeenCalled()
    expect(await prisma.supportMessage.findUniqueOrThrow({ where: { id } })).toMatchObject({ answer: SUPPORT_UNREGISTERED })
    expect(await prisma.supportAttempt.findFirstOrThrow({ where: { messageId: id } })).toMatchObject({ state: 'DEFINITIVE_FAILURE' })
    expect((await prisma.supportBudget.findUniqueOrThrow({ where: { key: 'AI:GLOBAL' } })).heldUsd.toString()).toBe('0')
  })
})
