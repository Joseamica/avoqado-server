/** Real Postgres, explicitly opt-in and restricted to this disposable database. */
import cuid from 'cuid'
const databaseUrl = process.env.TEST_DATABASE_URL
if (databaseUrl) {
  const url = new URL(databaseUrl)
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/avoqado_document_links_test_20261018')
    throw new Error('Unsafe document links database')
}
const describeDb = databaseUrl ? describe : describe.skip
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: new (require('@prisma/client').PrismaClient)({
    datasourceUrl: process.env.TEST_DATABASE_URL || 'postgresql://test:test@localhost/unused_document_links_test',
  }),
}))
jest.mock('@/config/env', () => ({ FRONTEND_URL: 'http://localhost:5173' }))
jest.mock('@/services/privateStorage.service', () => ({
  signPrivateAttachmentUrl: jest.fn().mockResolvedValue('https://storage.invalid/private-signed'),
  deletePrivateFile: jest.fn(),
}))
jest.mock('@/services/access/basePlan.service', () => ({ PAID_PLAN_TIER_CODES: [] }))
jest.mock('@/services/access/concederPlan', () => ({ exigirQueSePuedaConceder: jest.fn() }))
jest.mock('@/services/access/concederPlanDecision', () => ({ planesPedidos: jest.fn() }))
jest.mock('@/services/superadmin/settlementConfiguration.service', () => ({ bulkCreateSettlementConfigurations: jest.fn() }))
jest.mock('@/services/organization-payment-config.service', () => ({ getEffectivePaymentConfig: jest.fn() }))
jest.mock('@/services/modules/module.service', () => ({ moduleService: { enableModule: jest.fn() } }))
jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendTeamInvitation: jest.fn() } }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
import db from '@/utils/prismaClient'
import * as links from '@/services/document-requests/venueLinks.service'
import * as requests from '@/services/document-requests/documentRequests.service'
import { hashToken, getRequirements } from '@/services/document-requests/policy'
import { signPrivateAttachmentUrl, deletePrivateFile } from '@/services/privateStorage.service'
import { createVenueWizard } from '@/controllers/superadmin/onboarding.controller'
import { moduleService } from '@/services/modules/module.service'
import { Prisma } from '@prisma/client'
const prefix = 'LINKTEST-' + cuid(),
  token = 'ab'.repeat(32)
const requestIds: string[] = [],
  orgIds: string[] = [],
  venueIds: string[] = []
let actorId: string, orgId: string, otherOrgId: string, venueId: string
const contact = {
  businessName: 'Barbería de prueba',
  contactName: 'Ana',
  email: 'ana@example.org',
  phone: '5512345678',
  identificationType: 'INE',
  privacyAccepted: true,
}
async function makeOrg() {
  const row = await db.organization.create({ data: { name: prefix, slug: cuid(), email: 'links@example.org', phone: '5512345678' } })
  orgIds.push(row.id)
  return row.id
}
async function makeVenue(organizationId = orgId) {
  const row = await db.venue.create({ data: { organizationId, name: prefix, slug: cuid(), type: 'SALON', entityType: 'PERSONA_FISICA' } })
  venueIds.push(row.id)
  return row.id
}
async function makeRequest(legacy = false) {
  const row = await db.documentRequest.create({
    data: {
      provider: 'ANGELPAY',
      entityType: 'PERSONA_FISICA',
      businessName: contact.businessName,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 86400000),
      ...(legacy
        ? {
            status: 'SUBMITTED',
            submittedAt: new Date(),
            submissionVersion: 1,
            contactName: contact.contactName,
            email: contact.email,
            phone: contact.phone,
          }
        : {}),
    },
  })
  requestIds.push(row.id)
  for (const requirement of getRequirements('ANGELPAY', 'PERSONA_FISICA'))
    await db.documentRequestFile.create({
      data: {
        requestId: row.id,
        uploadId: cuid(),
        key: requirement.key,
        fileName: 'doc.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
        contentHash: 'immutable',
        storagePath: 'private/' + cuid() + '.pdf',
        tokenVersion: 1,
        status: 'READY',
      },
    })
  if (!legacy) await requests.submitRequest(row.id, token, contact)
  return row.id
}
const link = (requestId: string, target = venueId, version = 1) =>
  links.linkRequestToVenue(requestId, { venueId: target, submissionVersion: version, confirmed: true }, actorId)
async function wizard(body: unknown) {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() },
    next = jest.fn()
  await createVenueWizard({ body, authContext: { userId: actorId } } as any, res as any, next)
  if (next.mock.calls.length) throw next.mock.calls[0][0]
  return res.json.mock.calls[0][0]
}
function payload(requestId: string) {
  return {
    organization: { mode: 'new', name: prefix + '-wizard-' + cuid(), email: 'links@example.org', phone: '5512345678' },
    venue: { name: prefix, slug: cuid(), venueType: 'SALON', entityType: 'PERSONA_FISICA' },
    documentRequest: { id: requestId, submissionVersion: 1, confirmed: true },
    modules: [{ code: 'TEST_ONLY' }],
  }
}
async function transfer(tx: Prisma.TransactionClient, v: string, from: string, to: string) {
  for (const id of [from, to].sort()) await links.lockOrganizationTx(tx, id)
  await tx.$queryRaw`SELECT id FROM "Venue" WHERE id=${v} FOR UPDATE`
  await links.assertVenueHasNoDocumentLinksTx(tx, v)
  await tx.venue.update({ where: { id: v }, data: { organizationId: to } })
}
function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => {
    release = resolve
  })
  return { promise, release }
}
describeDb('venue document links disposable Postgres', () => {
  beforeAll(async () => {
    orgId = await makeOrg()
    otherOrgId = await makeOrg()
    venueId = await makeVenue()
    actorId = (await db.staff.create({ data: { firstName: 'Link', lastName: 'Test', email: prefix + '@example.org' } })).id
  })
  afterAll(async () => {
    // Every deletion is scoped to owned IDs; the controller's FULLTEST fixtures are untouched.
    if (requestIds.length) {
      await db.activityLog.deleteMany({ where: { OR: [{ entityId: { in: requestIds } }, { staffId: actorId }] } })
      await db.documentRequestVenueLink.deleteMany({ where: { requestId: { in: requestIds } } })
      await db.documentRequestSubmissionFile.deleteMany({ where: { submission: { requestId: { in: requestIds } } } })
      await db.documentRequestSubmission.deleteMany({ where: { requestId: { in: requestIds } } })
      await db.documentRequestDelivery.deleteMany({ where: { requestId: { in: requestIds } } })
      await db.documentRequestFile.deleteMany({ where: { requestId: { in: requestIds } } })
      await db.documentRequest.deleteMany({ where: { id: { in: requestIds } } })
    }
    if (orgIds.length) {
      const venues = await db.venue.findMany({ where: { organizationId: { in: orgIds } }, take: 100, select: { id: true } })
      const ids = venues.map(v => v.id)
      if (ids.length) {
        await db.venueSettings.deleteMany({ where: { venueId: { in: ids } } })
        await db.venue.deleteMany({ where: { id: { in: ids } } })
      }
      await db.organization.deleteMany({ where: { id: { in: orgIds } } })
    }
    if (actorId) await db.staff.delete({ where: { id: actorId } })
    await db.$disconnect()
  })
  test('lazy snapshot preserves legacy current submission; concurrent same-link creation writes once', async () => {
    const id = await makeRequest(true)
    expect(await db.documentRequestSubmission.count({ where: { requestId: id } })).toBe(0)
    const result = await Promise.all([link(id), link(id)])
    expect(result.map(r => r.created).sort()).toEqual([false, true])
    expect(result[0].link.id).toBe(result[1].link.id)
    expect(await db.documentRequestSubmission.count({ where: { requestId: id } })).toBe(1)
    expect(await db.activityLog.count({ where: { action: 'DOCUMENT_REQUEST_LINKED', entityId: result[0].link.id } })).toBe(1)
  })
  test('new delivery snapshot survives remove/discard/replacement/cleanup/revoke, while v2 is explicit', async () => {
    const id = await makeRequest(),
      first = await link(id)
    const original = await db.documentRequestFile.findFirstOrThrow({ where: { requestId: id, key: 'identification' } })
    const renewed = await requests.renewRequest(id, actorId),
      newToken = new URLSearchParams(renewed.uploadUrl.split('#')[1]).get('token')!
    await requests.deleteDocument(id, newToken, original.id)
    await requests.discardUpload(id, newToken, original.uploadId)
    await requests.discardUpload(id, newToken, original.uploadId)
    expect((await db.documentRequestFile.findUniqueOrThrow({ where: { id: original.id } })).status).toBe('ARCHIVED')
    await db.documentRequestFile.create({
      data: {
        requestId: id,
        uploadId: cuid(),
        key: original.key,
        fileName: 'replacement.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 20,
        contentHash: 'new',
        storagePath: 'private/' + cuid() + '.pdf',
        tokenVersion: 2,
        status: 'READY',
      },
    })
    await requests.submitRequest(id, newToken, { ...contact, contactName: 'Contacto nuevo' })
    expect((await links.getVenueDocumentRequest(venueId, first.link.id)).request.contactName).toBe('Ana')
    expect((await links.listVenueDocumentRequests(venueId)).items.filter(l => l.requestId === id)).toHaveLength(1)
    const second = await link(id, venueId, 2)
    expect((await links.getVenueDocumentRequest(venueId, second.link.id)).request.contactName).toBe('Contacto nuevo')
    await requests.revokeRequest(id, actorId)
    await requests.cleanupFiles(new Date(Date.now() + 40 * 86400000))
    expect(deletePrivateFile).not.toHaveBeenCalled()
    expect((await links.getVenueDocumentDownload(venueId, first.link.id, original.id)).url).toContain('signed')
    await expect(requests.getPublicRequest(id, newToken)).rejects.toThrow()
  })
  test('cross-organization/entity, draft and changed version reject without link writes', async () => {
    const id = await makeRequest()
    await link(id)
    await expect(link(id, await makeVenue(otherOrgId))).rejects.toThrow('otra organización')
    const other = await makeVenue()
    await db.venue.update({ where: { id: other }, data: { entityType: 'PERSONA_MORAL' } })
    await expect(link(id, other)).rejects.toThrow('tipo de persona')
    await expect(link(id, venueId, 2)).rejects.toThrow('cambió')
    await requests.renewRequest(id, actorId)
    await expect(link(id, await makeVenue())).rejects.toThrow('cambió')
    expect(await db.documentRequestVenueLink.count({ where: { requestId: id } })).toBe(1)
  })
  test('download rejects wrong venue/link/document and ordinary views expose no paths or tokens', async () => {
    const id = await makeRequest(),
      result = await link(id),
      file = await db.documentRequestFile.findFirstOrThrow({ where: { requestId: id } })
    ;(signPrivateAttachmentUrl as jest.Mock).mockClear()
    await expect(links.getVenueDocumentDownload(await makeVenue(), result.link.id, file.id)).rejects.toThrow('Documento no disponible')
    await expect(links.getVenueDocumentDownload(venueId, cuid(), file.id)).rejects.toThrow('Documento no disponible')
    await expect(links.getVenueDocumentDownload(venueId, result.link.id, cuid())).rejects.toThrow('Documento no disponible')
    expect(signPrivateAttachmentUrl).not.toHaveBeenCalled()
    const resultJson = JSON.stringify(await links.getVenueDocumentRequest(venueId, result.link.id))
    expect(resultJson).not.toMatch(/storagePath|tokenHash|onboardingHash|onboardingResult/)
  })
  test('links and options expose full totals and stable second page, search and empty result', async () => {
    const id = await makeRequest()
    for (let i = 0; i < 12; i++) await link(id, await makeVenue())
    const first = await links.listRequestVenueLinks(id),
      second = await links.listRequestVenueLinks(id, { page: 2 })
    expect(first).toMatchObject({ total: 12, page: 1, pageSize: 10 })
    expect(second.items).toHaveLength(2)
    expect(new Set([...first.items, ...second.items].map(i => i.id)).size).toBe(12)
    expect((await links.listVenueOptions({ pageSize: 10000, search: prefix })).pageSize).toBe(100)
    expect((await links.listVenueOptions({ search: cuid() })).total).toBe(0)
    expect((await links.listVenueOptions({ search: prefix, pageSize: 1, page: 2 })).items).toHaveLength(1)
  })
  test('database restricts direct venue organization transfer and link org mismatch', async () => {
    const id = await makeRequest(),
      v = await makeVenue()
    const result = await link(id, v)
    await expect(db.venue.update({ where: { id: v }, data: { organizationId: otherOrgId } })).rejects.toMatchObject({ code: 'P2003' })
    await expect(
      db.documentRequestVenueLink.update({ where: { id: result.link.id }, data: { organizationId: otherOrgId } }),
    ).rejects.toMatchObject({ code: 'P2003' })
    await expect(db.$transaction(tx => transfer(tx, v, orgId, otherOrgId))).rejects.toThrow('expedientes anexados')
  })
  test('link wins race: transfer waits and then rejects; transfer wins: stale link rejects or pins new org consistently', async () => {
    const id = await makeRequest(),
      v = await makeVenue(),
      held = barrier(),
      release = barrier()
    const winner = db.$transaction(
      async tx => {
        await links.lockOrganizationTx(tx, orgId)
        await tx.$queryRaw`SELECT id FROM "Venue" WHERE id=${v} FOR KEY SHARE`
        await links.linkRequestToVenueTx(tx, id, { venueId: v, submissionVersion: 1, confirmed: true }, actorId)
        held.release()
        await release.promise
      },
      { timeout: 10000 },
    )
    await held.promise
    const moving = db.$transaction(tx => transfer(tx, v, orgId, otherOrgId), { timeout: 10000 })
    release.release()
    await winner
    await expect(moving).rejects.toThrow('expedientes anexados')
    const id2 = await makeRequest(),
      v2 = await makeVenue(),
      held2 = barrier(),
      release2 = barrier()
    const movingFirst = db.$transaction(
      async tx => {
        await transfer(tx, v2, orgId, otherOrgId)
        held2.release()
        await release2.promise
      },
      { timeout: 10000 },
    )
    await held2.promise
    // Ensure the linker read the original organization before the transfer commits.
    const originalFind = db.venue.findUnique.bind(db.venue),
      read = barrier()
    const spy = jest.spyOn(db.venue, 'findUnique').mockImplementationOnce((async (args: any) => {
      const r = await originalFind(args)
      read.release()
      return r
    }) as any)
    const linking = link(id2, v2)
    await read.promise
    release2.release()
    await movingFirst
    await expect(linking).rejects.toThrow('cambió de organización')
    spy.mockRestore()
    expect(await db.documentRequestVenueLink.count({ where: { venueId: v2 } })).toBe(0)
  })
  test('wizard rolls back new org+venue when final link audit fails, then exact retry returns stored result after renewal', async () => {
    const id = await makeRequest(),
      body = payload(id),
      originalTransaction = db.$transaction.bind(db)
    const fault = jest.spyOn(db, '$transaction').mockImplementationOnce(((fn: any, options: any) =>
      originalTransaction(
        async tx =>
          fn(
            new Proxy(tx, {
              get(target, key) {
                if (key === 'activityLog')
                  return {
                    create: async () => {
                      throw new Error('injected final audit failure')
                    },
                  }
                return Reflect.get(target, key)
              },
            }),
          ),
        options,
      )) as any)
    await expect(wizard(body)).rejects.toThrow('injected final audit failure')
    fault.mockRestore()
    expect(await db.organization.count({ where: { name: body.organization.name } })).toBe(0)
    expect(await db.venue.count({ where: { slug: body.venue.slug } })).toBe(0)
    expect((await db.documentRequest.findUniqueOrThrow({ where: { id } })).organizationId).toBeNull()
    ;(moduleService.enableModule as jest.Mock).mockRejectedValueOnce(new Error('Original module failure'))
    const result = await wizard(body)
    orgIds.push(result.organizationId)
    venueIds.push(result.venueId)
    expect(result.steps).toContainEqual(expect.objectContaining({ step: 'modules', status: 'error', message: 'Original module failure' }))
    expect((await db.venue.findUniqueOrThrow({ where: { id: result.venueId } })).kycStatus).not.toBe('VERIFIED')
    await requests.renewRequest(id, actorId)
    const before = (moduleService.enableModule as jest.Mock).mock.calls.length
    const replay = await wizard(body)
    expect(replay).toEqual({ ...result, replayed: true })
    expect((moduleService.enableModule as jest.Mock).mock.calls.length).toBe(before)
    await db.documentRequestVenueLink.update({
      where: { onboardingHash: links.wizardHash(body) },
      data: { onboardingResult: Prisma.DbNull },
    })
    const pending = await wizard(body)
    expect(pending.configurationPending).toBe(true)
    expect(pending.steps).toContainEqual(expect.objectContaining({ step: 'configuration', status: 'error' }))
    expect((moduleService.enableModule as jest.Mock).mock.calls.length).toBe(before)
  })
})
