import cuid from 'cuid'
jest.mock('../../../src/utils/prismaClient', () => ({ __esModule: true, default: { $transaction: jest.fn() } }))
jest.mock('../../../src/config/env', () => ({ FRONTEND_URL: 'http://localhost:5173' }))
jest.mock('../../../src/services/privateStorage.service', () => ({
  buildPrivateFilePath: (s: string, n: string) => `private/dev/${s}/${n}`,
  savePrivateFileAtPath: jest.fn(),
  signPrivateAttachmentUrl: jest.fn(),
  deletePrivateFile: jest.fn(),
}))
import prisma from '../../../src/utils/prismaClient'
import * as storage from '../../../src/services/privateStorage.service'
import { admitUpload, uploadDocument, submitRequest } from '../../../src/services/document-requests/documentRequests.service'
import { hashToken } from '../../../src/services/document-requests/policy'
const token = 'ab'.repeat(32),
  id = cuid(),
  uploadId = cuid(),
  lease = cuid()
const file = { originalname: 'a.pdf', mimetype: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n%%EOF'), size: 14 } as Express.Multer.File
file.size = file.buffer.length
let row: any, tx: any
beforeEach(() => {
  jest.clearAllMocks()
  row = {
    id,
    provider: 'ANGELPAY',
    entityType: 'PERSONA_FISICA',
    tokenHash: hashToken(token),
    tokenVersion: 1,
    status: 'OPEN',
    expiresAt: new Date(Date.now() + 60000),
    uploadAttempts: 0,
    totalBytes: 0,
    uploadLease: lease,
    uploadLeaseUntil: new Date(Date.now() + 60000),
  }
  tx = {
    $executeRaw: jest.fn(),
    documentRequest: { findUnique: jest.fn(() => row), update: jest.fn() },
    documentRequestFile: {
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }) => ({ ...data, id: cuid() })),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    activityLog: { create: jest.fn() },
  }
  ;(prisma.$transaction as jest.Mock).mockImplementation(fn => fn(tx))
})
describe('atomic service boundaries', () => {
  test('attempt cap and live durable upload lease reject before parsing', async () => {
    row.uploadAttempts = 40
    row.uploadLeaseUntil = null
    await expect(admitUpload(id, token)).rejects.toThrow()
    row.uploadAttempts = 0
    row.uploadLeaseUntil = new Date(Date.now() + 60000)
    await expect(admitUpload(id, token)).rejects.toThrow()
    expect(tx.documentRequest.update).not.toHaveBeenCalled()
  })
  test('quota reservation is committed before storage and cumulative size cannot overflow', async () => {
    row.totalBytes = 64 * 1024 * 1024
    await expect(uploadDocument(id, token, 'identification', uploadId, file, { lease, tokenVersion: 1 })).rejects.toThrow()
    expect(storage.savePrivateFileAtPath).not.toHaveBeenCalled()
  })
  test('same uploadId and hash returns earlier metadata without another write', async () => {
    const hash = require('crypto').createHash('sha256').update(file.buffer).digest('hex')
    tx.documentRequestFile.findUnique.mockResolvedValue({
      id: cuid(),
      key: 'identification',
      contentHash: hash,
      status: 'READY',
      fileName: 'a.pdf',
      mimeType: 'application/pdf',
      sizeBytes: file.size,
    })
    await uploadDocument(id, token, 'identification', uploadId, file, { lease, tokenVersion: 1 })
    expect(storage.savePrivateFileAtPath).not.toHaveBeenCalled()
    expect(tx.documentRequestFile.create).not.toHaveBeenCalled()
  })
  test.each(['REVOKED', 'OPEN'])('revocation or renewal during Storage (%s) fences late confirmation', async state => {
    ;(storage.savePrivateFileAtPath as jest.Mock).mockImplementation(async () => {
      row = { ...row, status: state, tokenVersion: 2 }
    })
    await expect(uploadDocument(id, token, 'identification', uploadId, file, { lease, tokenVersion: 1 })).rejects.toThrow()
    expect(tx.documentRequestFile.update).not.toHaveBeenCalled()
    expect(tx.documentRequestFile.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ storagePath: expect.stringContaining(uploadId) }) }),
    )
  })
  test('submit bars inflight upload and replay of submitted request is idempotent', async () => {
    const contact = {
      businessName: 'Local',
      contactName: 'A',
      email: 'a@example.org',
      phone: '5512345678',
      identificationType: 'INE',
      privacyAccepted: true,
    }
    await expect(submitRequest(id, token, contact)).rejects.toThrow()
    row.status = 'SUBMITTED'
    await expect(submitRequest(id, token, contact)).resolves.toEqual({ id, status: 'SUBMITTED' })
    expect(tx.documentRequest.update).not.toHaveBeenCalled()
  })
})
