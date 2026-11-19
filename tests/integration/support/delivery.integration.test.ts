import prisma from '@/utils/prismaClient'
import { isSupportDataEnabled } from '@/config/supportWhatsapp'
import { admitSupportMessage, claimNext, type SupportClaim } from '@/services/support/store.service'
import { deliverSupportMessage, recordSupportDeliveryFailure } from '@/services/support/delivery.service'
import { runSupportBatch } from '@/services/support/worker.service'
import { supportCipher } from '@/services/support/link.service'
import * as demo from '@/services/demo/candadoDemo'
import type { VerifiedSection } from '@/services/support/knowledge.service'
import { SUPPORT_SEND_RETRY_NOTICE } from '@/services/support/texts'
const receiverId = `support-delivery-${Date.now()}`,
  phone = '+525500008001'
let serial = 0
const answer = 'Respuesta de prueba completa. Último paso. https://avoqado.io/help'
beforeAll(() =>
  Object.assign(process.env, {
    SUPPORT_WHATSAPP_ENABLED: 'true',
    SUPPORT_WHATSAPP_PHONE_NUMBER_ID: receiverId,
    WHATSAPP_SALES_PHONE_NUMBER_ID: 'sales',
    SUPPORT_WHATSAPP_ENC_KEY: 'e'.repeat(64),
    WHATSAPP_ACCESS_TOKEN: 'fixture-never-used',
  }),
)
async function clean() {
  await prisma.supportAttempt.deleteMany({ where: { message: { conversation: { receiverId } } } })
  await prisma.supportMessage.deleteMany({ where: { conversation: { receiverId } } })
  await prisma.supportLinkChallenge.deleteMany({ where: { conversation: { receiverId } } })
  await prisma.supportConversation.deleteMany({ where: { receiverId } })
  await prisma.whatsappInboundEvent.deleteMany({ where: { receiverId } })
}
beforeEach(async () => {
  await clean()
  process.env.SUPPORT_WHATSAPP_ENABLED = 'true'
})
afterEach(() => jest.restoreAllMocks())
afterAll(clean)
async function queued() {
  const { messageId } = await admitSupportMessage({
    receiverId,
    phone,
    wamid: `${receiverId}-${++serial}`,
    body: 'Pregunta',
    type: 'text',
    timestamp: String(Date.now() / 1000),
  })
  const message = await prisma.supportMessage.update({ where: { id: messageId }, data: { status: 'ANSWER_READY', answer } })
  await prisma.supportConversation.update({
    where: { id: message.conversationId },
    data: { app: 'dashboard', noticeAcceptedAt: new Date(), lastUserMessageAt: new Date(), lastActivityAt: new Date() },
  })
  return (await claimNext(new Date(Date.now() + 10), receiverId))!
}
it('persists SEND STARTED and the exact saved response before fetch, then records the returned wamid', async () => {
  const claim = await queued()
  global.fetch = jest.fn(async (_url, init) => {
    expect(await prisma.supportAttempt.findFirstOrThrow({ where: { messageId: claim.messageId } })).toMatchObject({
      kind: 'SEND',
      state: 'STARTED',
    })
    expect((await prisma.supportMessage.findUniqueOrThrow({ where: { id: claim.messageId } })).answer).toBe(answer)
    expect(JSON.parse(String(init!.body)).text.body).toBe(answer)
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.fixture-one' }] }), { status: 200 })
  }) as typeof fetch
  expect(await deliverSupportMessage(claim)).toBe('SENT')
  expect(global.fetch).toHaveBeenCalledTimes(1)
  expect(await prisma.supportMessage.findUniqueOrThrow({ where: { id: claim.messageId } })).toMatchObject({
    status: 'SENT',
    outboundWamid: 'wamid.fixture-one',
    claimToken: null,
  })
})
it('two workers with the same claim may make only one outgoing request', async () => {
  const claim = await queued()
  global.fetch = jest.fn(
    async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.fixture-race' }] }), { status: 200 }),
  ) as typeof fetch
  await Promise.all([deliverSupportMessage(claim), deliverSupportMessage(claim)])
  expect(global.fetch).toHaveBeenCalledTimes(1)
  expect(await prisma.supportAttempt.count({ where: { messageId: claim.messageId, kind: 'SEND' } })).toBe(1)
})
it.each(['lost-response', 'missing-wamid'])('an uncertain %s is retained, never automatically resent', async kind => {
  const claim = await queued()
  global.fetch = jest.fn(async () => {
    if (kind === 'lost-response') throw new TypeError('fixture timeout after POST')
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  expect(await deliverSupportMessage(claim)).toBe('UNKNOWN')
  expect(await prisma.supportMessage.findUniqueOrThrow({ where: { id: claim.messageId } })).toMatchObject({
    status: 'SEND_UNKNOWN',
    answer,
  })
  expect(await claimNext(new Date(), receiverId)).toBeNull()
  await deliverSupportMessage(claim)
  expect(global.fetch).toHaveBeenCalledTimes(1)
})
it.each(['off', 'expired-window', 'idle', 'closed', 'generation'])('does not send after %s', async kind => {
  const claim = await queued()
  if (kind === 'off') process.env.SUPPORT_WHATSAPP_ENABLED = 'false'
  if (kind === 'expired-window')
    await prisma.supportConversation.update({
      where: { id: claim.conversationId },
      data: { lastUserMessageAt: new Date(Date.now() - 86400001) },
    })
  if (kind === 'idle')
    await prisma.supportConversation.update({
      where: { id: claim.conversationId },
      data: { lastActivityAt: new Date(Date.now() - 1800001) },
    })
  if (kind === 'closed') await prisma.supportConversation.update({ where: { id: claim.conversationId }, data: { mode: 'CLOSED' } })
  if (kind === 'generation')
    await prisma.supportConversation.update({ where: { id: claim.conversationId }, data: { generation: { increment: 1 } } })
  global.fetch = jest.fn()
  await deliverSupportMessage(claim)
  expect(global.fetch).not.toHaveBeenCalled()
})
it('failed delivery correlation is scoped to its own receiver, and idempotently records a definitive failure', async () => {
  const claim = await queued()
  global.fetch = jest.fn(
    async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.fixture-failed' }] }), { status: 200 }),
  ) as typeof fetch
  await deliverSupportMessage(claim)
  expect(await recordSupportDeliveryFailure('wamid.fixture-failed', 'foreign')).toBe(false)
  expect(await recordSupportDeliveryFailure('wamid.fixture-failed', receiverId)).toBe(true)
  expect(await recordSupportDeliveryFailure('wamid.fixture-failed', receiverId)).toBe(true)
  expect(await prisma.supportMessage.findUniqueOrThrow({ where: { id: claim.messageId } })).toMatchObject({ status: 'FAILED' })
})
it.each(['on', 'off'])('retains a failed callback before acknowledgement even when the operator flag becomes %s', async flag => {
  const claim = await queued()
  global.fetch = jest.fn(async () => {
    if (flag === 'off') process.env.SUPPORT_WHATSAPP_ENABLED = 'false'
    await recordSupportDeliveryFailure('wamid.fixture-early', receiverId)
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.fixture-early' }] }), { status: 200 })
  }) as typeof fetch
  await deliverSupportMessage(claim)
  expect(await prisma.supportMessage.findUniqueOrThrow({ where: { id: claim.messageId } })).toMatchObject({
    status: 'FAILED',
    outboundWamid: 'wamid.fixture-early',
  })
  expect(await prisma.supportAttempt.findFirstOrThrow({ where: { messageId: claim.messageId, kind: 'SEND' } })).toMatchObject({
    state: 'DEFINITIVE_FAILURE',
  })
  expect(global.fetch).toHaveBeenCalledTimes(1)
  expect(await claimNext(new Date(), receiverId)).toBeNull()
})
it.each(['off', 'window', 'idle', 'generation', 'closed', 'lease'])(
  'rechecks %s after the sender’s asynchronous demo gate, before the actual POST',
  async kind => {
    const claim = await queued()
    jest.spyOn(demo, 'omitirPorDemo').mockImplementationOnce(async () => {
      if (kind === 'off') process.env.SUPPORT_WHATSAPP_ENABLED = 'false'
      if (kind === 'window')
        await prisma.supportConversation.update({
          where: { id: claim.conversationId },
          data: { lastUserMessageAt: new Date(Date.now() - 86400001) },
        })
      if (kind === 'idle')
        await prisma.supportConversation.update({
          where: { id: claim.conversationId },
          data: { lastActivityAt: new Date(Date.now() - 1800001) },
        })
      if (kind === 'closed') await prisma.supportConversation.update({ where: { id: claim.conversationId }, data: { mode: 'CLOSED' } })
      if (kind === 'generation')
        await prisma.supportConversation.update({ where: { id: claim.conversationId }, data: { generation: { increment: 1 } } })
      if (kind === 'lease')
        await prisma.supportMessage.update({ where: { id: claim.messageId }, data: { leaseUntil: new Date(Date.now() - 1) } })
      return null
    })
    global.fetch = jest.fn(
      async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.fixture-forbidden' }] }), { status: 200 }),
    ) as typeof fetch
    await deliverSupportMessage(claim)
    expect(global.fetch).not.toHaveBeenCalled()
  },
)
it.each(['inactive', 'cut', 'unlink'])('rechecks personal identity after the sender wait: %s', async kind => {
  const claim = await queued()
  const staff = await prisma.staff.create({
    data: { email: `${receiverId}-${kind}@test.local`, firstName: 'Personal', lastName: 'Prueba' },
  })
  try {
    const link = await prisma.supportWhatsappLink.create({
      data: { staffId: staff.id, phone, verifiedAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 86400000) },
    })
    await prisma.supportConversation.update({
      where: { id: claim.conversationId },
      data: {
        mode: 'PERSONAL',
        staffId: staff.id,
        linkId: link.id,
        pendingSelection: 'VENUE',
        selectionOptions: { items: [], nextCursor: null },
        selectionExpiresAt: new Date(Date.now() + 600000),
      },
    })
    jest.spyOn(demo, 'omitirPorDemo').mockImplementationOnce(async () => {
      if (kind === 'inactive') await prisma.staff.update({ where: { id: staff.id }, data: { active: false } })
      if (kind === 'cut') await prisma.staff.update({ where: { id: staff.id }, data: { sessionsRevokedAt: new Date() } })
      if (kind === 'unlink') await prisma.supportWhatsappLink.delete({ where: { id: link.id } })
      return null
    })
    global.fetch = jest.fn(
      async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.fixture-revoked' }] }), { status: 200 }),
    ) as typeof fetch
    await deliverSupportMessage(claim)
    expect(demo.omitirPorDemo).toHaveBeenCalled()
    expect(global.fetch).not.toHaveBeenCalled()
  } finally {
    await clean()
    await prisma.supportWhatsappLink.deleteMany({ where: { staffId: staff.id } })
    await prisma.staff.delete({ where: { id: staff.id } })
  }
})
it.each(['role', 'membership', 'activation', 'venue-selection', 'selection-unchanged'])(
  'rechecks changed %s after the sender wait',
  async kind => {
    const claim = await queued()
    const org = await prisma.organization.create({
      data: { name: receiverId, email: `${receiverId}-${kind}@test.local`, phone: '0000000000' },
    })
    const venue = await prisma.venue.create({
      data: { organizationId: org.id, name: 'Prueba', slug: `${receiverId}-${kind}`, status: 'ACTIVE' },
    })
    const staff = await prisma.staff.create({
      data: { email: `${receiverId}-${kind}@test.local`, firstName: 'Permisos', lastName: 'Prueba' },
    })
    const guide: VerifiedSection = {
      id: 'dashboard/menu/gestionar-productos',
      app: 'dashboard',
      title: 'Guía de prueba',
      summary: 'Resumen revisado',
      steps: ['Paso completo'],
      publicUrl: 'https://avoqado.io/help/dashboard/menu/gestionar-productos',
      requiredPermissions: ['menu:read'],
      keywords: [],
      activationKey: 'enableShifts',
    }
    const selecting = kind === 'venue-selection' || kind === 'selection-unchanged'
    try {
      await prisma.staffOrganization.create({ data: { staffId: staff.id, organizationId: org.id, role: 'MEMBER' } })
      await prisma.staffVenue.create({ data: { staffId: staff.id, venueId: venue.id, role: 'MANAGER' } })
      await prisma.venueSettings.create({ data: { venueId: venue.id, enableShifts: true } })
      const link = await prisma.supportWhatsappLink.create({
        data: { staffId: staff.id, phone, verifiedAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 86400000) },
      })
      await prisma.supportConversation.update({
        where: { id: claim.conversationId },
        data: {
          mode: 'PERSONAL',
          staffId: staff.id,
          linkId: link.id,
          ...(selecting
            ? {
                pendingSelection: 'VENUE',
                selectionOptions: { items: [{ value: venue.id, orgId: org.id, label: venue.name }], nextCursor: null },
                selectionExpiresAt: new Date(Date.now() + 600000),
              }
            : { orgId: org.id, venueId: venue.id }),
        },
      })
      if (!selecting) await prisma.supportMessage.update({ where: { id: claim.messageId }, data: { sourceIds: [guide.id] } })
      jest.spyOn(demo, 'omitirPorDemo').mockImplementationOnce(async () => {
        if (kind === 'role')
          await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: staff.id, venueId: venue.id } }, data: { role: 'VIEWER' } })
        if (kind === 'membership')
          await prisma.staffOrganization.update({
            where: { staffId_organizationId: { staffId: staff.id, organizationId: org.id } },
            data: { isActive: false },
          })
        if (kind === 'activation') await prisma.venueSettings.update({ where: { venueId: venue.id }, data: { enableShifts: false } })
        if (kind === 'venue-selection') await prisma.venue.update({ where: { id: venue.id }, data: { name: 'Nombre nuevo' } })
        return null
      })
      global.fetch = jest.fn(
        async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.fixture-access' }] }), { status: 200 }),
      ) as typeof fetch
      await deliverSupportMessage(claim, [guide])
      expect(demo.omitirPorDemo).toHaveBeenCalled()
      expect(global.fetch).toHaveBeenCalledTimes(kind === 'selection-unchanged' ? 1 : 0)
    } finally {
      await clean()
      await prisma.supportWhatsappLink.deleteMany({ where: { staffId: staff.id } })
      await prisma.staffVenue.deleteMany({ where: { staffId: staff.id } })
      await prisma.staffOrganization.deleteMany({ where: { staffId: staff.id } })
      await prisma.staff.delete({ where: { id: staff.id } })
      await prisma.venueSettings.deleteMany({ where: { venueId: venue.id } })
      await prisma.venue.delete({ where: { id: venue.id } })
      await prisma.organization.delete({ where: { id: org.id } })
    }
  },
)
// T-B40: una selección de sucursal pendiente que listaba una sucursal heredada (dueña de la organización, sin asignación directa en
// ella) deja de valer al suspenderse esa sucursal, porque ya no se lista: SUPPORT_ACCESS_REVOKED y el aviso público, sin mandar nada.
it.each(['unchanged', 'suspended'])('a pending venue selection that listed an inherited venue, %s (T-B40)', async kind => {
  const claim = await queued()
  const org = await prisma.organization.create({
    data: { name: `${receiverId}-owner`, email: `${receiverId}-owner-${kind}@test.local`, phone: '0000000000' },
  })
  const venue = (name: string) =>
    prisma.venue.create({ data: { organizationId: org.id, name, slug: `${receiverId}-${name.toLowerCase()}-${kind}`, status: 'ACTIVE' } })
  const direct = await venue('Directa')
  const inherited = await venue('Heredada')
  const staff = await prisma.staff.create({
    data: { email: `${receiverId}-owner-${kind}@test.local`, firstName: 'Dueña', lastName: 'Prueba' },
  })
  try {
    await prisma.staffOrganization.create({ data: { staffId: staff.id, organizationId: org.id, role: 'OWNER' } })
    await prisma.staffVenue.create({ data: { staffId: staff.id, venueId: direct.id, role: 'OWNER' } })
    const link = await prisma.supportWhatsappLink.create({
      data: { staffId: staff.id, phone, verifiedAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 86400000) },
    })
    await prisma.supportConversation.update({
      where: { id: claim.conversationId },
      data: {
        mode: 'PERSONAL',
        staffId: staff.id,
        linkId: link.id,
        pendingSelection: 'VENUE',
        selectionOptions: { items: [direct, inherited].map(v => ({ value: v.id, orgId: org.id, label: v.name })), nextCursor: null },
        selectionExpiresAt: new Date(Date.now() + 600000),
      },
    })
    // Como la deja suspenderla (venue.dashboard.service.ts): estado SUSPENDED y active en false.
    if (kind === 'suspended') await prisma.venue.update({ where: { id: inherited.id }, data: { status: 'SUSPENDED', active: false } })
    global.fetch = jest.fn(
      async () => new Response(JSON.stringify({ messages: [{ id: `wamid.fixture-owner-${kind}` }] }), { status: 200 }),
    ) as typeof fetch
    const result = await deliverSupportMessage(claim)
    expect(global.fetch).toHaveBeenCalledTimes(kind === 'unchanged' ? 1 : 0)
    if (kind === 'suspended') {
      expect(result).toBe('CANCELLED')
      expect((await prisma.supportMessage.findUniqueOrThrow({ where: { id: claim.messageId } })).answer).toMatch(
        /^Tu acceso cambió o esta selección ya no está vigente/,
      )
    }
  } finally {
    await clean()
    await prisma.supportWhatsappLink.deleteMany({ where: { staffId: staff.id } })
    await prisma.staffVenue.deleteMany({ where: { staffId: staff.id } })
    await prisma.staffOrganization.deleteMany({ where: { staffId: staff.id } })
    await prisma.staff.delete({ where: { id: staff.id } })
    await prisma.venue.deleteMany({ where: { organizationId: org.id } })
    await prisma.organization.delete({ where: { id: org.id } })
  }
})
it.each(['valid', 'expired', 'revoked', 'late-expired', 'late-consumed', 'late-cut', 'late-demo'])(
  'sends a link code only with a %s challenge and account, never storing it in plaintext',
  async kind => {
    const opening = await queued()
    await prisma.supportMessage.update({ where: { id: opening.messageId }, data: { status: 'SENT', claimToken: null, leaseUntil: null } })
    const staff = await prisma.staff.create({ data: { email: `${receiverId}-${kind}@test.local`, firstName: 'OTP', lastName: 'Prueba' } })
    try {
      const expiresAt = new Date(Date.now() + 600000),
        code = '123456'
      const challenge = await prisma.supportLinkChallenge.create({
        data: { staffId: staff.id, phone, conversationId: opening.conversationId, operationKey: kind, codeHash: 'fixture-hash', expiresAt },
      })
      const message = await prisma.supportMessage.create({
        data: {
          conversationId: opening.conversationId,
          generation: opening.generation,
          sequence: 2,
          purpose: 'LINK_CODE',
          challengeId: challenge.id,
          status: 'ANSWER_READY',
          body: '',
          answerCipher: supportCipher.encryptToBase64(code),
          expiresAt,
        },
      })
      if (kind === 'expired')
        await prisma.supportLinkChallenge.update({ where: { id: challenge.id }, data: { expiresAt: new Date(Date.now() - 1) } })
      if (kind === 'revoked') await prisma.staff.update({ where: { id: staff.id }, data: { sessionsRevokedAt: new Date() } })
      const claim = (await claimNext(new Date(Date.now() + 10), receiverId))!
      if (kind.startsWith('late-'))
        jest.spyOn(demo, 'omitirPorDemo').mockImplementationOnce(async () => {
          if (kind === 'late-expired')
            await prisma.supportLinkChallenge.update({ where: { id: challenge.id }, data: { expiresAt: new Date(Date.now() - 1) } })
          if (kind === 'late-consumed')
            await prisma.supportLinkChallenge.update({ where: { id: challenge.id }, data: { consumedAt: new Date() } })
          if (kind === 'late-cut') await prisma.staff.update({ where: { id: staff.id }, data: { sessionsRevokedAt: new Date() } })
          if (kind === 'late-demo') await prisma.staff.update({ where: { id: staff.id }, data: { email: `${receiverId}@demo.avoqado.io` } })
          return null
        })
      global.fetch = jest.fn(async (_url, init) => {
        expect(JSON.parse(String(init!.body)).text.body).toContain(code)
        const saved = await prisma.supportMessage.findUniqueOrThrow({ where: { id: message.id } })
        expect(saved.answer).toBeNull()
        expect(saved.body).toBe('')
        return new Response(JSON.stringify({ messages: [{ id: 'wamid.fixture-otp' }] }), { status: 200 })
      }) as typeof fetch
      await deliverSupportMessage(claim)
      expect(global.fetch).toHaveBeenCalledTimes(kind === 'valid' ? 1 : 0)
      expect((await prisma.supportMessage.findUniqueOrThrow({ where: { id: message.id } })).answerCipher).toBeNull()
    } finally {
      await clean()
      await prisma.staff.delete({ where: { id: staff.id } })
    }
  },
)
describe('the venue line and a moved phone (SUPPORT_WHATSAPP_FREE_TEXT_ENABLED)', () => {
  const guide: VerifiedSection = {
    id: 'dashboard/menu/gestionar-productos',
    app: 'dashboard',
    title: 'Guía de prueba',
    summary: 'Resumen revisado',
    steps: ['Paso completo'],
    publicUrl: 'https://avoqado.io/help/dashboard/menu/gestionar-productos',
    requiredPermissions: [],
    keywords: [],
  }
  let orgId: string, staffId: string, otherId: string
  const venueIds: string[] = []
  beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: receiverId, email: `${receiverId}-line@test.local`, phone: '0000000000' } }))
      .id
    for (const name of ['Centro', 'Norte'])
      venueIds.push(
        (await prisma.venue.create({ data: { organizationId: orgId, name, slug: `${receiverId}-line-${name}`, status: 'ACTIVE' } })).id,
      )
    staffId = (await prisma.staff.create({ data: { email: `${receiverId}-line@test.local`, firstName: 'Sucursal', lastName: 'Prueba' } }))
      .id
    otherId = (await prisma.staff.create({ data: { email: `${receiverId}-line-b@test.local`, firstName: 'Otra', lastName: 'Cuenta' } })).id
    await prisma.staffOrganization.create({ data: { staffId, organizationId: orgId, role: 'MEMBER' } })
    await prisma.staffVenue.createMany({
      data: [
        ...venueIds.map(venueId => ({ staffId, venueId, role: 'VIEWER' as const })),
        { staffId: otherId, venueId: venueIds[0], role: 'VIEWER' },
      ],
    })
  })
  beforeEach(() => {
    process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED = 'true'
  })
  afterEach(async () => {
    delete process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED
    await clean()
    await prisma.supportWhatsappLink.deleteMany({ where: { staffId } })
    await prisma.staff.updateMany({ where: { id: { in: [staffId, otherId] } }, data: { phone: null } })
    await prisma.staffVenue.updateMany({ where: { staffId }, data: { active: true } })
  })
  afterAll(async () => {
    await prisma.staffVenue.deleteMany({ where: { staffId: { in: [staffId, otherId] } } })
    await prisma.staffOrganization.deleteMany({ where: { staffId } })
    await prisma.staff.deleteMany({ where: { id: { in: [staffId, otherId] } } })
    await prisma.venue.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.delete({ where: { id: orgId } })
  })
  async function personal(saved = answer) {
    const claim = await queued()
    const link = await prisma.supportWhatsappLink.create({
      data: { staffId, phone, verifiedAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 86400000) },
    })
    await prisma.supportConversation.update({
      where: { id: claim.conversationId },
      data: { mode: 'PERSONAL', staffId, linkId: link.id, orgId, venueId: venueIds[0] },
    })
    await prisma.supportMessage.update({ where: { id: claim.messageId }, data: { sourceIds: [guide.id], answer: saved } })
    global.fetch = jest.fn(
      async () => new Response(JSON.stringify({ messages: [{ id: `wamid.line-${serial}` }] }), { status: 200 }),
    ) as typeof fetch
    return claim
  }
  const sentBody = () => JSON.parse(String((global.fetch as jest.Mock).mock.calls[0][1].body)).text.body as string
  it.each([
    ['', 'Viendo Centro. Escribe SUCURSAL para cambiar.\n\nGuía de prueba'],
    [
      `${SUPPORT_SEND_RETRY_NOTICE}\n\n${answer}`,
      `Viendo Centro. Escribe SUCURSAL para cambiar.\n\n${SUPPORT_SEND_RETRY_NOTICE}\n\nGuía de prueba`,
    ],
  ])('with several venues the body starts with the venue line (saved answer %j)', async (prefix, start) => {
    expect(await deliverSupportMessage(await personal(prefix || answer), [guide])).toBe('SENT')
    expect(sentBody().startsWith(start)).toBe(true)
  })
  it('with one venue there is no venue line', async () => {
    await prisma.staffVenue.updateMany({ where: { staffId, venueId: venueIds[1] }, data: { active: false } })
    expect(await deliverSupportMessage(await personal(), [guide])).toBe('SENT')
    expect(sentBody().startsWith('Guía de prueba')).toBe(true)
  })
  it('flag off: no venue line', async () => {
    delete process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED
    expect(await deliverSupportMessage(await personal(), [guide])).toBe('SENT')
    expect(sentBody().startsWith('Guía de prueba')).toBe(true)
  })
  it.each(['also', 'moves'])('a personal answer for A whose phone %s to B is not sent and becomes public help', async kind => {
    if (kind === 'also') await prisma.staff.update({ where: { id: staffId }, data: { phone } })
    await prisma.staff.update({ where: { id: otherId }, data: { phone } })
    const claim = await personal()
    expect(await deliverSupportMessage(claim, [guide])).toBe('CANCELLED')
    expect(global.fetch).not.toHaveBeenCalled()
    expect((await prisma.supportMessage.findUniqueOrThrow({ where: { id: claim.messageId } })).answer).toMatch(/^Tu acceso cambió/)
    expect(await prisma.supportConversation.findUniqueOrThrow({ where: { id: claim.conversationId } })).toMatchObject({
      mode: 'PUBLIC',
      staffId: null,
    })
  })
})

// La B no toca la entrega de hoy: este archivo no prende SUPPORT_DATA_ENABLED (Task 10).
it('HELP and LINK_CODE messages are delivered exactly as before (the cipher of a LINK_CODE is erased when sent)', async () => {
  expect(isSupportDataEnabled()).toBe(false)
  const help = await queued()
  global.fetch = jest.fn(
    async () => new Response(JSON.stringify({ messages: [{ id: `wamid.fixture-help-${serial}` }] }), { status: 200 }),
  ) as typeof fetch
  expect(await deliverSupportMessage(help)).toBe('SENT')
  expect(JSON.parse(String((global.fetch as jest.Mock).mock.calls[0][1].body)).text.body).toBe(answer)
  expect(await prisma.supportMessage.findUniqueOrThrow({ where: { id: help.messageId } })).toMatchObject({
    status: 'SENT',
    purpose: 'HELP',
    answer,
    answerCipher: null,
  })
  const staff = await prisma.staff.create({ data: { email: `${receiverId}-as-before@test.local`, firstName: 'OTP', lastName: 'Prueba' } })
  try {
    const expiresAt = new Date(Date.now() + 600000)
    const challenge = await prisma.supportLinkChallenge.create({
      data: {
        staffId: staff.id,
        phone,
        conversationId: help.conversationId,
        operationKey: 'as-before',
        codeHash: 'fixture-hash',
        expiresAt,
      },
    })
    const code = await prisma.supportMessage.create({
      data: {
        conversationId: help.conversationId,
        generation: help.generation,
        sequence: 2,
        purpose: 'LINK_CODE',
        challengeId: challenge.id,
        status: 'ANSWER_READY',
        body: '',
        answerCipher: supportCipher.encryptToBase64('654321'),
        expiresAt,
      },
    })
    global.fetch = jest.fn(
      async () => new Response(JSON.stringify({ messages: [{ id: `wamid.fixture-code-${serial}` }] }), { status: 200 }),
    ) as typeof fetch
    expect(await deliverSupportMessage((await claimNext(new Date(Date.now() + 10), receiverId))!)).toBe('SENT')
    expect(JSON.parse(String((global.fetch as jest.Mock).mock.calls[0][1].body)).text.body).toContain('654321')
    expect(await prisma.supportMessage.findUniqueOrThrow({ where: { id: code.id } })).toMatchObject({
      status: 'SENT',
      answer: null,
      answerCipher: null,
    })
  } finally {
    await clean()
    await prisma.staff.delete({ where: { id: staff.id } })
  }
})

// ─── T-B21 (caso 53): la entrega de GUÍAS reconoce la sucursal perdida también cuando llega como Error simple ──────────────
type Seed = { claim: SupportClaim; guide: VerifiedSection; staffId: string; venueId: string; orgId: string; clean(): Promise<void> }
/**
 * La siembra del it.each de «rechecks changed %s after the sender wait», sacada a un ayudante para no copiarla: organización, sucursal,
 * persona MANAGER con su membresía MEMBER activa, vínculo vigente, plática PERSONAL en esa sucursal y un mensaje ANSWER_READY que cita
 * una guía que pide `menu:read`.
 */
async function personalGuide(tag: string): Promise<Seed> {
  const claim = await queued()
  const guide: VerifiedSection = {
    id: 'dashboard/menu/gestionar-productos',
    app: 'dashboard',
    title: 'Guía de prueba',
    summary: 'Resumen revisado',
    steps: ['Paso completo'],
    publicUrl: 'https://avoqado.io/help/dashboard/menu/gestionar-productos',
    requiredPermissions: ['menu:read'],
    keywords: [],
  }
  const org = await prisma.organization.create({
    data: { name: `${receiverId}-${tag}`, email: `${receiverId}-${tag}@test.local`, phone: '0000000000' },
  })
  const venue = await prisma.venue.create({
    data: { organizationId: org.id, name: 'Prueba', slug: `${receiverId}-${tag}`, status: 'ACTIVE' },
  })
  const staff = await prisma.staff.create({ data: { email: `${receiverId}-${tag}@test.local`, firstName: 'Guía', lastName: 'Prueba' } })
  await prisma.staffOrganization.create({ data: { staffId: staff.id, organizationId: org.id, role: 'MEMBER' } })
  await prisma.staffVenue.create({ data: { staffId: staff.id, venueId: venue.id, role: 'MANAGER' } })
  const link = await prisma.supportWhatsappLink.create({
    data: { staffId: staff.id, phone, verifiedAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 86400000) },
  })
  await prisma.supportConversation.update({
    where: { id: claim.conversationId },
    data: { mode: 'PERSONAL', staffId: staff.id, linkId: link.id, orgId: org.id, venueId: venue.id },
  })
  await prisma.supportMessage.update({ where: { id: claim.messageId }, data: { sourceIds: [guide.id] } })
  return {
    claim,
    guide,
    staffId: staff.id,
    venueId: venue.id,
    orgId: org.id,
    async clean() {
      await clean()
      await prisma.supportWhatsappLink.deleteMany({ where: { staffId: staff.id } })
      await prisma.staffVenue.deleteMany({ where: { staffId: staff.id } })
      await prisma.staffOrganization.deleteMany({ where: { staffId: staff.id } })
      await prisma.staff.delete({ where: { id: staff.id } })
      await prisma.venue.delete({ where: { id: venue.id } })
      await prisma.organization.delete({ where: { id: org.id } })
    },
  }
}
const NOTICE = 'Tu acceso cambió o esta selección ya no está vigente.'
const PUBLIC = { mode: 'PUBLIC', staffId: null, linkId: null, orgId: null, venueId: null }
const lose = {
  // Le apagan su fila de la sucursal y conserva su membresía: getUserAccess lanza un Error simple (access/access.service.ts:410)
  'venue-off': (s: Seed) =>
    prisma.staffVenue.update({ where: { staffId_venueId: { staffId: s.staffId, venueId: s.venueId } }, data: { active: false } }),
  // Regresión: le apagan la membresía y resolveHelpAccess lanza ForbiddenError (support/access.service.ts:39-40), el camino que ya existía
  membership: (s: Seed) =>
    prisma.staffOrganization.update({
      where: { staffId_organizationId: { staffId: s.staffId, organizationId: s.orgId } },
      data: { isActive: false },
    }),
}
const state = async (s: Seed) => ({
  message: await prisma.supportMessage.findUniqueOrThrow({ where: { id: s.claim.messageId }, include: { attempts: true } }),
  conversation: await prisma.supportConversation.findUniqueOrThrow({ where: { id: s.claim.conversationId } }),
})

// Las dos formas de perder la sucursal terminan IGUAL: eso es lo que pide T-B21, y `membership` es la regresión de lo que ya pasaba
describe.each(['venue-off', 'membership'] as const)('a guide answer whose person lost the venue (%s)', kind => {
  it('before the first checkpoint: the public notice replaces the answer and the chat returns to public help', async () => {
    const s = await personalGuide(`first-${kind}`)
    try {
      await lose[kind](s)
      global.fetch = jest.fn() as typeof fetch
      await expect(deliverSupportMessage(s.claim, [s.guide])).resolves.toBe('CANCELLED') // hoy, con venue-off, rechaza con el Error simple
      const { message, conversation } = await state(s)
      expect(message).toMatchObject({ status: 'ANSWER_READY', claimToken: null, sourceIds: [], attempts: [] })
      expect(message.answer).toContain(NOTICE)
      expect(conversation).toMatchObject(PUBLIC)
      expect(global.fetch).not.toHaveBeenCalled()
    } finally {
      await s.clean()
    }
  })
  it('between the two checkpoints: nothing goes out, the message is CANCELLED and the chat returns to public help', async () => {
    const s = await personalGuide(`second-${kind}`)
    try {
      jest.spyOn(demo, 'omitirPorDemo').mockImplementationOnce(async () => {
        await lose[kind](s)
        return null
      })
      global.fetch = jest.fn() as typeof fetch
      await expect(deliverSupportMessage(s.claim, [s.guide])).resolves.toBe('CANCELLED') // hoy, con venue-off, da 'UNKNOWN'
      const { message, conversation } = await state(s)
      expect(message.status).toBe('CANCELLED') // hoy, con venue-off, queda FAILED
      expect(message.attempts).toMatchObject([{ kind: 'SEND', state: 'DEFINITIVE_FAILURE' }])
      expect(conversation).toMatchObject(PUBLIC) // hoy, con venue-off, sigue PERSONAL
      expect(global.fetch).not.toHaveBeenCalled()
    } finally {
      await s.clean()
    }
  })
})
it('any other error still goes up as today: a failed read of the link rejects and the chat stays PERSONAL', async () => {
  const s = await personalGuide('other-error')
  try {
    jest.spyOn(prisma.supportWhatsappLink, 'findUnique').mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
    global.fetch = jest.fn() as typeof fetch
    await expect(deliverSupportMessage(s.claim, [s.guide])).rejects.toThrow('ECONNREFUSED')
    expect((await state(s)).conversation).toMatchObject({ mode: 'PERSONAL', staffId: s.staffId, venueId: s.venueId })
    expect(global.fetch).not.toHaveBeenCalled()
  } finally {
    await s.clean()
  }
})
it('venue-off before the first checkpoint: the batch does not fail, the public notice goes out once and nothing is re-claimed in a loop', async () => {
  const s = await personalGuide('batch')
  try {
    await lose['venue-off'](s)
    // Se suelta el apartado de la siembra para que lo tome el lote (claimNext sólo toma QUEUED o ANSWER_READY sin apartado)
    await prisma.supportMessage.update({
      where: { id: s.claim.messageId },
      data: { status: 'ANSWER_READY', claimToken: null, leaseUntil: null },
    })
    global.fetch = jest.fn(
      async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.fixture-b21' }] }), { status: 200 }),
    ) as typeof fetch
    const run = () => runSupportBatch(new Date(Date.now() + 10), { sections: [s.guide] })
    const first = await run() // hoy rechaza con SUPPORT_BATCH_FAILED
    const second = await run()
    expect(first.claimed + second.claimed).toBe(2) // una vez la guía y una vez el aviso; ninguna más
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(JSON.stringify((global.fetch as jest.Mock).mock.calls[0])).toContain(NOTICE)
    expect((await state(s)).message.status).toBe('SENT')
    expect((await run()).claimed).toBe(0)
  } finally {
    await s.clean()
  }
})
