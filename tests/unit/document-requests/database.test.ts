/** Opt-in real Postgres checks; never loads the shared local database URL. */
import cuid from 'cuid'
const databaseUrl = process.env.PORTAL_DOCUMENTS_DATABASE_URL
if (databaseUrl && new URL(databaseUrl).pathname !== '/avoqado_portaldocs_test_20261017')
  throw new Error('Unsafe document requests test database')
const describeDb = databaseUrl ? describe : describe.skip
jest.mock('../../../src/config/env', () => ({ FRONTEND_URL: 'http://localhost:5173' }))
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: new (require('@prisma/client').PrismaClient)({
    datasourceUrl: process.env.PORTAL_DOCUMENTS_DATABASE_URL || 'postgresql://test:test@localhost/unused_document_requests_test',
  }),
}))
jest.mock('../../../src/services/privateStorage.service', () => ({
  buildPrivateFilePath: (s: string, n: string) => `private/dev/${s}/${n}`,
  savePrivateFileAtPath: jest.fn().mockResolvedValue(undefined),
  signPrivateAttachmentUrl: jest.fn().mockResolvedValue('https://storage.invalid/attachment'),
  deletePrivateFile: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../../../src/services/email.service', () => ({ __esModule: true, default: { sendEmailWithResult: jest.fn() } }))
import db from '../../../src/utils/prismaClient'
import * as storage from '../../../src/services/privateStorage.service'
import emailService from '../../../src/services/email.service'
import * as service from '../../../src/services/document-requests/documentRequests.service'
import { deliverNotifications } from '../../../src/services/document-requests/notifications'
import { getRequirements } from '../../../src/services/document-requests/policy'
const ids: string[] = []
const contact = {
  businessName: 'Local prueba',
  contactName: 'Prueba',
  email: 'test@example.org',
  phone: '5512345678',
  identificationType: 'INE',
  privacyAccepted: true,
}
const pdf = () => {
  const buffer = Buffer.from('%PDF-1.7\n%%EOF')
  return { originalname: 'doc.pdf', mimetype: 'application/pdf', buffer, size: buffer.length } as Express.Multer.File
}
async function create() {
  const r = await service.createRequest({ provider: 'ANGELPAY', entityType: 'PERSONA_FISICA', businessName: 'DB test' })
  ids.push(r.request.id)
  return { id: r.request.id, token: new URLSearchParams(r.uploadUrl.split('#')[1]).get('token')! }
}
async function upload(r: { id: string; token: string }, key: string, uploadId = cuid()) {
  const admission = await service.admitUpload(r.id, r.token)
  try {
    return await service.uploadDocument(r.id, r.token, key, uploadId, pdf(), admission)
  } finally {
    await service.releaseUpload(r.id, admission)
  }
}
async function deliverOnly(requestId: string, now = new Date()) {
  const findMany = db.documentRequestDelivery.findMany.bind(db.documentRequestDelivery)
  const scoped = jest
    .spyOn(db.documentRequestDelivery, 'findMany')
    .mockImplementation(((query: any) => findMany({ ...query, where: { ...query.where, requestId } })) as any)
  try {
    await deliverNotifications(now)
  } finally {
    scoped.mockRestore()
  }
}
describeDb('disposable Postgres document requests', () => {
  afterAll(async () => {
    if (ids.length) {
      await db.activityLog.deleteMany({ where: { entity: 'DocumentRequest', entityId: { in: ids } } })
      await db.documentRequestDelivery.deleteMany({ where: { requestId: { in: ids } } })
      await db.documentRequestFile.deleteMany({ where: { requestId: { in: ids } } })
      await db.documentRequest.deleteMany({ where: { id: { in: ids } } })
    }
    await db.$disconnect()
  })
  test('concurrent pre-multipart admissions admit one, and accumulated quota rejects a new upload', async () => {
    const r = await create()
    const both = await Promise.allSettled([service.admitUpload(r.id, r.token), service.admitUpload(r.id, r.token)])
    expect(both.filter(x => x.status === 'fulfilled')).toHaveLength(1)
    for (const result of both) if (result.status === 'fulfilled') await service.releaseUpload(r.id, result.value)
    await db.documentRequest.update({ where: { id: r.id }, data: { totalBytes: 64 * 1024 * 1024 } })
    await expect(upload(r, 'identification')).rejects.toThrow()
    expect(await db.documentRequestFile.count({ where: { requestId: r.id } })).toBe(0)
  })
  test('response replay deduplicates and cross-request download is denied', async () => {
    const r = await create(),
      other = await create(),
      key = cuid()
    const first = await upload(r, 'identification', key),
      second = await upload(r, 'identification', key)
    expect(first).toEqual(second)
    expect(await db.documentRequestFile.count({ where: { requestId: r.id } })).toBe(1)
    await expect(service.getDownloadUrl(other.id, first.document.id)).rejects.toThrow()
  })
  test('unknown Storage result is recovered with the same upload ID and create-only 412', async () => {
    const r = await create(),
      uploadId = cuid()
    ;(storage.savePrivateFileAtPath as jest.Mock).mockRejectedValueOnce(new Error('Lost Storage response'))
    await expect(upload(r, 'identification', uploadId)).rejects.toThrow('Lost Storage response')
    expect((await service.getPublicRequest(r.id, r.token)).pendingUploads).toEqual([
      { uploadId, key: 'identification', fileName: 'doc.pdf' },
    ])
    const reserved = await db.documentRequest.findUniqueOrThrow({ where: { id: r.id } })
    ;(storage.savePrivateFileAtPath as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('Already exists'), { code: 412 }))
    await expect(upload(r, 'identification', uploadId)).resolves.toHaveProperty('document.id')
    expect((await service.getPublicRequest(r.id, r.token)).pendingUploads).toEqual([])
    expect(await db.documentRequestFile.count({ where: { requestId: r.id, status: 'READY' } })).toBe(1)
    expect((await db.documentRequest.findUniqueOrThrow({ where: { id: r.id } })).totalBytes).toBe(reserved.totalBytes)
  })
  test('cleanup leaves stale pending uploads alone while their durable lease is active', async () => {
    const r = await create(),
      admission = await service.admitUpload(r.id, r.token)
    ;(storage.savePrivateFileAtPath as jest.Mock).mockRejectedValueOnce(new Error('Storage unavailable'))
    await expect(service.uploadDocument(r.id, r.token, 'identification', cuid(), pdf(), admission)).rejects.toThrow()
    const old = new Date(Date.now() - 31 * 60000)
    await db.documentRequestFile.updateMany({ where: { requestId: r.id }, data: { updatedAt: old } })
    await service.cleanupFiles()
    expect(await db.documentRequestFile.count({ where: { requestId: r.id, status: 'PENDING' } })).toBe(1)
    await service.releaseUpload(r.id, admission)
    await service.cleanupFiles()
    expect(await db.documentRequestFile.count({ where: { requestId: r.id, status: 'DELETED' } })).toBe(1)
  })
  test('renewal after failed Storage immediately permits completing and submitting the new link', async () => {
    const r = await create()
    ;(storage.savePrivateFileAtPath as jest.Mock).mockRejectedValueOnce(new Error('Storage unavailable'))
    await expect(upload(r, 'identification')).rejects.toThrow()
    const renewed = await service.renewRequest(r.id)
    const current = { id: r.id, token: new URLSearchParams(renewed.uploadUrl.split('#')[1]).get('token')! }
    for (const requirement of getRequirements('ANGELPAY', 'PERSONA_FISICA')) await upload(current, requirement.key)
    await expect(service.submitRequest(current.id, current.token, contact)).resolves.toEqual({ id: r.id, status: 'SUBMITTED' })
    // Keep this fixture out of the separate notification retry assertion below.
    await db.documentRequestDelivery.updateMany({ where: { requestId: r.id }, data: { nextAttemptAt: new Date(Date.now() + 86400000) } })
  })
  test.each(['revoke', 'renew'])('%s during Storage prevents late confirmation', async operation => {
    const r = await create()
    let finish!: () => void, started!: () => void
    const signal = new Promise<void>(resolve => {
        started = resolve
      }),
      gate = new Promise<void>(resolve => {
        finish = resolve
      })
    ;(storage.savePrivateFileAtPath as jest.Mock).mockImplementationOnce(async () => {
      started()
      await gate
    })
    const admission = await service.admitUpload(r.id, r.token)
    const pending = service.uploadDocument(r.id, r.token, 'identification', cuid(), pdf(), admission)
    await signal
    let newToken = ''
    if (operation === 'revoke') await service.revokeRequest(r.id)
    else newToken = new URLSearchParams((await service.renewRequest(r.id)).uploadUrl.split('#')[1]).get('token')!
    finish()
    await expect(pending).rejects.toThrow()
    await service.releaseUpload(r.id, admission)
    expect(await db.documentRequestFile.count({ where: { requestId: r.id, status: 'READY' } })).toBe(0)
    if (operation === 'renew') {
      expect(await db.documentRequestFile.count({ where: { requestId: r.id, status: 'PENDING' } })).toBe(0)
      await expect(upload({ id: r.id, token: newToken }, 'identification')).resolves.toHaveProperty('document.id')
    }
  })
  test('explicitly discarding a failed upload permits replacement and submission', async () => {
    const r = await create(),
      uploadId = cuid()
    ;(storage.savePrivateFileAtPath as jest.Mock).mockRejectedValueOnce(new Error('Storage unavailable'))
    await expect(upload(r, 'identification', uploadId)).rejects.toThrow()
    await expect(service.discardUpload(r.id, r.token, uploadId)).resolves.toEqual({ success: true })
    await expect(service.discardUpload(r.id, r.token, uploadId)).resolves.toEqual({ success: true })
    for (const requirement of getRequirements('ANGELPAY', 'PERSONA_FISICA')) await upload(r, requirement.key)
    await expect(service.submitRequest(r.id, r.token, contact)).resolves.toEqual({ id: r.id, status: 'SUBMITTED' })
    await db.documentRequestDelivery.updateMany({ where: { requestId: r.id }, data: { nextAttemptAt: new Date(Date.now() + 86400000) } })
  })
  test('renew, resubmit and revoke do not cancel either frozen notification version', async () => {
    const r = await create()
    for (const requirement of getRequirements('ANGELPAY', 'PERSONA_FISICA')) await upload(r, requirement.key)
    await service.submitRequest(r.id, r.token, contact)
    const renewed = await service.renewRequest(r.id)
    const token = new URLSearchParams(renewed.uploadUrl.split('#')[1]).get('token')!
    await service.submitRequest(r.id, token, contact)
    await service.revokeRequest(r.id)
    ;(emailService.sendEmailWithResult as jest.Mock).mockClear().mockResolvedValue({ ok: true, transient: false })
    await deliverOnly(r.id)
    const deliveries = await db.documentRequestDelivery.findMany({ where: { requestId: r.id }, take: 4 })
    expect(deliveries).toHaveLength(4)
    expect(deliveries.every(row => row.status === 'SENT')).toBe(true)
    expect(emailService.sendEmailWithResult).toHaveBeenCalledTimes(4)
    const snapshots = deliveries.map(row => (row.snapshot as any).version).sort()
    expect(snapshots).toEqual([1, 1, 2, 2])
  })
  test('parallel submit is idempotent and each recipient retries independently', async () => {
    ;(emailService.sendEmailWithResult as jest.Mock).mockReset()
    const r = await create()
    for (const requirement of getRequirements('ANGELPAY', 'PERSONA_FISICA')) await upload(r, requirement.key)
    await Promise.all([service.submitRequest(r.id, r.token, contact), service.submitRequest(r.id, r.token, contact)])
    const row = await db.documentRequest.findUniqueOrThrow({ where: { id: r.id } })
    expect(row.submissionVersion).toBe(1)
    expect(await db.activityLog.count({ where: { entityId: r.id, action: 'DOCUMENT_REQUEST_SUBMITTED' } })).toBe(1)
    ;(emailService.sendEmailWithResult as jest.Mock)
      .mockResolvedValueOnce({ ok: true, transient: false })
      .mockResolvedValueOnce({ ok: false, transient: true })
    await deliverOnly(r.id)
    const first = await db.documentRequest.findUniqueOrThrow({ where: { id: r.id } })
    expect(first.onboardingNotification).toBe('SENT')
    expect(first.danielNotification).toBe('PENDING')
    await db.documentRequestDelivery.updateMany({ where: { requestId: r.id, status: 'PENDING' }, data: { nextAttemptAt: new Date(0) } })
    ;(emailService.sendEmailWithResult as jest.Mock).mockResolvedValueOnce({ ok: true, transient: false })
    await deliverOnly(r.id)
    expect((await db.documentRequest.findUniqueOrThrow({ where: { id: r.id } })).danielNotification).toBe('SENT')
    expect(emailService.sendEmailWithResult).toHaveBeenCalledTimes(3)
  })
  test('summary write failure rolls back terminal delivery and retries with the same provider key', async () => {
    const r = await create()
    for (const requirement of getRequirements('ANGELPAY', 'PERSONA_FISICA')) await upload(r, requirement.key)
    await service.submitRequest(r.id, r.token, contact)
    const send = emailService.sendEmailWithResult as jest.Mock
    send.mockReset().mockResolvedValue({ ok: true, transient: false })
    const transaction = db.$transaction.bind(db) as any
    const fault = jest.spyOn(db, '$transaction').mockImplementationOnce(((work: any) =>
      transaction(async (tx: any) =>
        work({
          documentRequestDelivery: tx.documentRequestDelivery,
          documentRequest: {
            updateMany: async () => {
              throw new Error('summary write failed')
            },
          },
        }),
      )) as any)
    try {
      await expect(deliverOnly(r.id)).rejects.toThrow('summary write failed')
    } finally {
      fault.mockRestore()
    }
    const rows = await db.documentRequestDelivery.findMany({ where: { requestId: r.id }, take: 2 })
    expect(rows.every(row => row.status === 'PENDING')).toBe(true)
    const before = await db.documentRequest.findUniqueOrThrow({ where: { id: r.id } })
    expect(before.onboardingNotification).toBe('PENDING')
    expect(before.danielNotification).toBe('PENDING')
    const firstKey = send.mock.calls[0][0].idempotencyKey
    await db.documentRequestDelivery.updateMany({
      where: { requestId: r.id },
      data: { leaseUntil: new Date(0), nextAttemptAt: new Date(0) },
    })
    await deliverOnly(r.id)
    expect((await db.documentRequestDelivery.findMany({ where: { requestId: r.id }, take: 2 })).every(row => row.status === 'SENT')).toBe(
      true,
    )
    const after = await db.documentRequest.findUniqueOrThrow({ where: { id: r.id } })
    expect(after.onboardingNotification).toBe('SENT')
    expect(after.danielNotification).toBe('SENT')
    expect(send.mock.calls.filter(call => call[0].idempotencyKey === firstKey)).toHaveLength(2)
  })
})
