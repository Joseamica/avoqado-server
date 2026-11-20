import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import * as linkService from '@/services/support/link.service'
const { supportCipher } = linkService
import { resolveHelpAccess, listSupportVenues } from '@/services/support/access.service'

const receiverId = `support-link-${Date.now()}`
const strongAuthAt = new Date()
const requestLink = (staffId: string, input: { phone: string; operationKey: string }) =>
  linkService.requestLink(staffId, input, { strongAuthAt })
const verifyLink = (staffId: string, input: { challengeId: string; code: string }) =>
  linkService.verifyLink(staffId, input, { strongAuthAt })
const unlink = (staffId: string, venueId?: string) => linkService.unlink(staffId, { strongAuthAt, venueId })
const phone = '+525511112222'
let staffId: string, otherId: string, orgId: string, venueId: string, sessionId: string
const post = (route: string, body: Record<string, unknown>, token: string) =>
  request(app)
    .post(`/api/v1/me/support-whatsapp/${route}`)
    .set('X-Support-Staff-Id', staffId)
    .set('Origin', 'https://support-qa.avoqado-web-dashboard-4wx.pages.dev')
    .set('Cookie', `accessToken=${token}`)
    .send(body)
const token = (overrides: Record<string, unknown> = {}) =>
  jwt.sign({ sub: staffId, orgId, venueId, role: 'VIEWER', sid: sessionId, ...overrides }, process.env.ACCESS_TOKEN_SECRET!, {
    expiresIn: '10m',
  })
const codeFor = async (id: string) =>
  supportCipher.decryptFromBase64((await prisma.supportMessage.findUniqueOrThrow({ where: { challengeId: id } })).answerCipher!)

beforeAll(async () => {
  process.env.SUPPORT_WHATSAPP_ENABLED = 'true'
  process.env.SUPPORT_WHATSAPP_ENC_KEY = 'e'.repeat(64)
  process.env.SUPPORT_WHATSAPP_PHONE_NUMBER_ID = receiverId
  process.env.WHATSAPP_SALES_PHONE_NUMBER_ID = 'sales-only'
  const org = await prisma.organization.create({ data: { name: receiverId, email: `${receiverId}@test.local`, phone: '0000000000' } })
  orgId = org.id
  const venue = await prisma.venue.create({ data: { organizationId: orgId, name: 'Soporte', slug: receiverId, status: 'ACTIVE' } })
  venueId = venue.id
  const staff = await prisma.staff.create({ data: { email: `${receiverId}@test.local`, firstName: 'Soporte', lastName: 'Prueba', phone } })
  staffId = staff.id
  const other = await prisma.staff.create({ data: { email: `other-${receiverId}@test.local`, firstName: 'Otra', lastName: 'Persona' } })
  otherId = other.id
  await prisma.staffVenue.create({ data: { staffId, venueId, role: 'VIEWER' } })
  await prisma.staffOrganization.create({ data: { staffId, organizationId: orgId, role: 'MEMBER' } })
  const session = await prisma.session.create({ data: { staffId, venueId, authMethod: 'PASSWORD', strongAuthAt: new Date() } })
  sessionId = session.id
})

beforeEach(async () => {
  await prisma.staff.update({ where: { id: staffId }, data: { active: true, lastPasswordReset: null, sessionsRevokedAt: null } })
  await prisma.staffOrganization.updateMany({ where: { staffId, organizationId: orgId }, data: { isActive: true, leftAt: null } })
  await prisma.session.update({
    where: { id: sessionId },
    data: { revokedAt: null, deviceId: null, authMethod: 'PASSWORD', strongAuthAt: new Date() },
  })
  await prisma.supportMessage.deleteMany({ where: { conversation: { receiverId } } })
  await prisma.supportLinkChallenge.deleteMany({ where: { conversation: { receiverId } } })
  await prisma.supportConversation.deleteMany({ where: { receiverId } })
  await prisma.supportWhatsappLink.deleteMany({ where: { staffId: { in: [staffId, otherId] } } })
  await prisma.supportConversation.create({ data: { receiverId, phone, lastUserMessageAt: new Date() } })
})

afterAll(async () => {
  delete process.env.SUPPORT_WHATSAPP_ENABLED
  if (!staffId) return
  await prisma.supportMessage.deleteMany({ where: { conversation: { receiverId } } })
  await prisma.supportLinkChallenge.deleteMany({ where: { conversation: { receiverId } } })
  await prisma.supportConversation.deleteMany({ where: { receiverId } })
  await prisma.supportWhatsappLink.deleteMany({ where: { staffId: { in: [staffId, otherId] } } })
  await prisma.activityLog.deleteMany({ where: { staffId: { in: [staffId, otherId] } } })
  await prisma.session.deleteMany({ where: { staffId: { in: [staffId, otherId] } } })
  await prisma.staffVenue.deleteMany({ where: { staffId } })
  await prisma.staffOrganization.deleteMany({ where: { staffId } })
  await prisma.staff.deleteMany({ where: { id: { in: [staffId, otherId] } } })
  if (venueId) await prisma.venue.delete({ where: { id: venueId } })
  if (orgId) await prisma.organization.delete({ where: { id: orgId } })
})

describe('personal WhatsApp link, real DB and HTTP boundary', () => {
  it('an unmarked historical session cannot grant a phone link, even after a venue switch', async () => {
    await prisma.session.update({ where: { id: sessionId }, data: { strongAuthAt: null } })
    expect((await post('challenge', { phone, operationKey: 'unmarked-history', personalPhone: true }, token())).status).toBe(403)
    const switched = await request(app)
      .post('/api/v1/dashboard/auth/switch-venue')
      .set('Origin', 'https://support-qa.avoqado-web-dashboard-4wx.pages.dev')
      .set('Cookie', `accessToken=${token()}`)
      .send({ venueId })
    expect(switched.status).toBe(200)
    const cookies = switched.headers['set-cookie'] as unknown as string[]
    const accessCookie = cookies.find(c => c.startsWith('accessToken='))!.split(';')[0]
    expect(
      (
        await request(app)
          .post('/api/v1/me/support-whatsapp/challenge')
          .set('X-Support-Staff-Id', staffId)
          .set('Origin', 'https://support-qa.avoqado-web-dashboard-4wx.pages.dev')
          .set('Cookie', accessCookie)
          .send({ phone, operationKey: 'after-weak-switch', personalPhone: true })
      ).status,
    ).toBe(403)
    expect(await prisma.supportLinkChallenge.count({ where: { staffId } })).toBe(0)
  })

  it('unlink clears identity without reopening CLOSED conversations', async () => {
    const closed = await prisma.supportConversation.create({ data: { receiverId, phone, staffId, mode: 'CLOSED' } })
    await prisma.supportWhatsappLink.create({ data: { staffId, phone, expiresAt: new Date(Date.now() + 86_400_000) } })
    await unlink(staffId)
    expect(await prisma.supportConversation.findUnique({ where: { id: closed.id } })).toMatchObject({ mode: 'CLOSED', staffId: null })
    expect(await prisma.supportConversation.count({ where: { receiverId, phone, mode: { not: 'CLOSED' } } })).toBe(1)
  })

  it('VIEWER uses a password session, one idempotent operation, encrypted code and concurrent confirmation', async () => {
    const body = { phone: '+5215511112222', operationKey: 'same-operation', personalPhone: true }
    const [a, b] = await Promise.all([post('challenge', body, token()), post('challenge', body, token())])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(a.body.challengeId).toBe(b.body.challengeId)
    expect(await prisma.supportLinkChallenge.count({ where: { staffId } })).toBe(1)
    const code = await codeFor(a.body.challengeId)
    const results = await Promise.all([
      post('verify', { challengeId: a.body.challengeId, code }, token()),
      post('verify', { challengeId: a.body.challengeId, code }, token()),
    ])
    expect(results.map(r => r.status)).toEqual([200, 200])
    expect(await prisma.supportWhatsappLink.count({ where: { staffId } })).toBe(1)
    expect(await prisma.activityLog.count({ where: { staffId, action: 'SUPPORT_WHATSAPP_LINKED', venueId } })).toBe(1)
    expect((await prisma.supportMessage.findUnique({ where: { challengeId: a.body.challengeId } }))?.answerCipher).toBeNull()
    await unlink(staffId, venueId)
    expect(await verifyLink(staffId, { challengeId: a.body.challengeId, code })).toEqual({ linked: false })
    expect(await prisma.supportWhatsappLink.count({ where: { staffId } })).toBe(0)
  })

  it('does not accept a stored Staff.phone, foreign challenge, wrong code, expiry or a sixth attempt', async () => {
    expect(await prisma.supportWhatsappLink.count({ where: { staffId } })).toBe(0)
    const challenge = await requestLink(staffId, { phone, operationKey: 'failures' })
    const good = await codeFor(challenge.challengeId)
    await expect(verifyLink(otherId, { challengeId: challenge.challengeId, code: good })).rejects.toMatchObject({
      code: 'SUPPORT_CODE_INVALID',
    })
    for (let i = 0; i < 5; i++)
      await expect(
        verifyLink(staffId, { challengeId: challenge.challengeId, code: good === '000000' ? '111111' : '000000' }),
      ).rejects.toMatchObject({ code: 'SUPPORT_CODE_INVALID' })
    await expect(verifyLink(staffId, { challengeId: challenge.challengeId, code: good })).rejects.toMatchObject({
      code: 'SUPPORT_CODE_INVALID',
    })
    expect((await prisma.supportLinkChallenge.findUnique({ where: { id: challenge.challengeId } }))?.attempts).toBe(5)
    await prisma.supportLinkChallenge.update({
      where: { id: challenge.challengeId },
      data: { attempts: 0, invalidatedAt: null, expiresAt: new Date(Date.now() - 1) },
    })
    await expect(verifyLink(staffId, { challengeId: challenge.challengeId, code: good })).rejects.toMatchObject({
      code: 'SUPPORT_CODE_INVALID',
    })
  })

  it.each(['lastPasswordReset', 'sessionsRevokedAt'] as const)(
    '%s invalidates challenges and existing links, including equal-millisecond grants',
    async field => {
      const challenge = await requestLink(staffId, { phone, operationKey: `cut-${field}` })
      const code = await codeFor(challenge.challengeId)
      const original = await prisma.supportLinkChallenge.findUniqueOrThrow({ where: { id: challenge.challengeId } })
      await prisma.staff.update({ where: { id: staffId }, data: { [field]: original.createdAt } })
      await expect(verifyLink(staffId, { challengeId: challenge.challengeId, code })).rejects.toMatchObject({
        code: 'SUPPORT_ACCESS_REVOKED',
      })
      const { getLinkStatus } = await import('@/services/support/link.service')
      await prisma.supportWhatsappLink.create({
        data: { staffId, phone, verifiedAt: original.createdAt, expiresAt: new Date(Date.now() + 86_400_000) },
      })
      expect(await getLinkStatus(staffId)).toMatchObject({ linked: false, phone: null })
    },
  )

  it('enforces the minute and hourly limits per phone and staff, without giving another account away', async () => {
    const a = await requestLink(staffId, { phone, operationKey: 'rate-a' })
    await expect(requestLink(staffId, { phone, operationKey: 'rate-b' })).rejects.toMatchObject({ code: 'SUPPORT_CODE_RATE_LIMIT' })
    await prisma.supportLinkChallenge.update({ where: { id: a.challengeId }, data: { createdAt: new Date(Date.now() - 61_000) } })
    const b = await requestLink(staffId, { phone, operationKey: 'rate-b' })
    await prisma.supportLinkChallenge.update({ where: { id: b.challengeId }, data: { createdAt: new Date(Date.now() - 61_000) } })
    const c = await requestLink(staffId, { phone, operationKey: 'rate-c' })
    await prisma.supportLinkChallenge.update({ where: { id: c.challengeId }, data: { createdAt: new Date(Date.now() - 61_000) } })
    await expect(requestLink(staffId, { phone, operationKey: 'rate-d' })).rejects.toMatchObject({ code: 'SUPPORT_CODE_RATE_LIMIT' })
    await prisma.supportWhatsappLink.create({ data: { staffId: otherId, phone, expiresAt: new Date(Date.now() + 86_400_000) } })
    await expect(requestLink(staffId, { phone, operationKey: 'occupied' })).rejects.toMatchObject({ code: 'SUPPORT_PHONE_UNAVAILABLE' })
  })

  it('org removal wins over the remaining venue assignment, and venue pagination has an exact total', async () => {
    expect(await resolveHelpAccess({ staffId, orgId, venueId })).toMatchObject({ permissions: expect.any(Array) })
    const page = await listSupportVenues(staffId, { limit: 10000 })
    expect(page.total).toBe(1)
    expect(page.items.map(i => i.id)).toEqual([venueId])
    await prisma.staffOrganization.updateMany({ where: { staffId, organizationId: orgId }, data: { isActive: false } })
    await expect(resolveHelpAccess({ staffId, orgId, venueId })).rejects.toMatchObject({ code: 'SUPPORT_ACCESS_REVOKED' })
    expect(await listSupportVenues(staffId, {})).toMatchObject({ items: [], total: 0 })
  })

  it('requires a fresh personal session, explicit consent, JSON and a trusted cookie Origin', async () => {
    const body = { phone, operationKey: 'auth-boundary', personalPhone: true }
    expect((await post('challenge', { ...body, personalPhone: false }, token())).status).toBe(400)
    expect((await post('challenge', body, token({ sid: undefined }))).status).toBe(403)
    expect((await post('challenge', body, token({ sub: otherId }))).status).toBe(403)
    expect(
      (
        await request(app)
          .post('/api/v1/me/support-whatsapp/challenge')
          .set('X-Support-Staff-Id', staffId)
          .set('Cookie', `accessToken=${token()}`)

          .send(body)
      ).status,
    ).toBe(403)
    expect(
      (
        await request(app)
          .post('/api/v1/me/support-whatsapp/challenge')
          .set('X-Support-Staff-Id', staffId)
          .set('Cookie', `accessToken=${token()}`)
          .set('Origin', 'https://support-qa.avoqado-web-dashboard-4wx.pages.dev')
          .type('form')
          .send('phone=x')
      ).status,
    ).toBe(415)
    await prisma.session.update({ where: { id: sessionId }, data: { authMethod: 'PIN' } })
    expect((await post('challenge', body, token())).status).toBe(403)
    await prisma.session.update({ where: { id: sessionId }, data: { authMethod: 'PASSWORD', revokedAt: new Date() } })
    expect([401, 403]).toContain((await post('challenge', body, token())).status)
    expect(await prisma.supportLinkChallenge.count({ where: { staffId } })).toBe(0)
  })

  it('a fresh password login can reach status and unlink after the last venue is lost, without granting a business scope', async () => {
    const password = 'support-fixture-not-real'
    const staff = await prisma.staff.update({
      where: { id: staffId },
      data: { password: await bcrypt.hash(password, 4), emailVerified: true },
    })
    await prisma.supportWhatsappLink.create({ data: { staffId, phone, expiresAt: new Date(Date.now() + 86400000) } })
    await prisma.staffVenue.updateMany({ where: { staffId, venueId }, data: { active: false } })
    try {
      const browser = request.agent(app)
      const login = await browser.post('/api/v1/dashboard/auth/login').send({ email: staff.email, password, purpose: 'support-whatsapp' })
      expect(login.status).toBe(200)
      const status = await browser.get('/api/v1/dashboard/auth/status')
      expect(status.body).toMatchObject({ authenticated: true, user: { id: staffId, venues: [] } })
      expect((await browser.get('/api/v1/me/support-whatsapp/status').set('X-Support-Staff-Id', staffId)).body).toMatchObject({
        linked: true,
      })
      const unlinked = await browser
        .post('/api/v1/me/support-whatsapp/unlink')
        .set('X-Support-Staff-Id', staffId)
        .set('Origin', 'https://support-qa.avoqado-web-dashboard-4wx.pages.dev')
        .send({})
      expect(unlinked.status).toBe(200)
      expect(unlinked.body).toEqual({ linked: false })
      expect(await prisma.supportWhatsappLink.count({ where: { staffId } })).toBe(0)
      expect((await request(app).post('/api/v1/dashboard/auth/login').send({ email: staff.email, password })).status).toBe(403)
    } finally {
      await prisma.staffVenue.updateMany({ where: { staffId, venueId }, data: { active: true } })
    }
  })
  it('a request bound to A cannot read B, create B’s challenge or remove B’s link after browser cookies change', async () => {
    const otherSession = await prisma.session.create({
      data: { staffId: otherId, venueId: 'support-personal', authMethod: 'PASSWORD', strongAuthAt: new Date() },
    })
    await prisma.supportWhatsappLink.create({
      data: { staffId: otherId, phone: '+525511112223', expiresAt: new Date(Date.now() + 86400000) },
    })
    const cookie = `accessToken=${token({ sub: otherId, sid: otherSession.id })}`
    const status = await request(app).get('/api/v1/me/support-whatsapp/status').set('Cookie', cookie).set('X-Support-Staff-Id', staffId)
    expect(status.status).toBe(403)
    expect(status.body.code).toBe('SUPPORT_IDENTITY_CHANGED')
    expect(JSON.stringify(status.body)).not.toContain('2223')
    for (const action of ['unlink', 'challenge']) {
      const result = await request(app)
        .post(`/api/v1/me/support-whatsapp/${action}`)
        .set('Cookie', cookie)
        .set('X-Support-Staff-Id', staffId)
        .set('Origin', 'https://support-qa.avoqado-web-dashboard-4wx.pages.dev')
        .send(action === 'challenge' ? { phone, operationKey: 'from-old-person', personalPhone: true } : {})
      expect(result.status).toBe(403)
      expect(result.body.code).toBe('SUPPORT_IDENTITY_CHANGED')
    }
    expect(await prisma.supportWhatsappLink.count({ where: { staffId: otherId } })).toBe(1)
    expect(await prisma.supportLinkChallenge.count({ where: { staffId: otherId } })).toBe(0)
    const preflight = await request(app)
      .options('/api/v1/me/support-whatsapp/status')
      .set('Origin', 'https://support-qa.avoqado-web-dashboard-4wx.pages.dev')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'x-support-staff-id')
    expect(preflight.status).toBe(200)
    expect(preflight.headers['access-control-allow-headers'].toLowerCase()).toContain('x-support-staff-id')
  })
  it('unlink remains reachable after losing the last venue', async () => {
    await prisma.supportWhatsappLink.create({ data: { staffId, phone, expiresAt: new Date(Date.now() + 86_400_000) } })
    await prisma.staffVenue.updateMany({ where: { staffId, venueId }, data: { active: false } })
    expect((await post('unlink', {}, token())).status).toBe(200)
    expect(await prisma.supportWhatsappLink.count({ where: { staffId } })).toBe(0)
    await prisma.staffVenue.updateMany({ where: { staffId, venueId }, data: { active: true } })
  })
})
