import cuid from 'cuid'
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: { $transaction: jest.fn(), documentRequestFile: { findMany: jest.fn(), updateMany: jest.fn() } },
}))
jest.mock('../../../src/config/env', () => ({ FRONTEND_URL: 'http://localhost:5173' }))
jest.mock('../../../src/services/privateStorage.service', () => ({ deletePrivateFile: jest.fn() }))
import prisma from '../../../src/utils/prismaClient'
import { deleteDocument, discardUpload, cleanupFiles } from '../../../src/services/document-requests/documentRequests.service'
import { deletePrivateFile } from '../../../src/services/privateStorage.service'
import { hashToken } from '../../../src/services/document-requests/policy'
const id = cuid(),
  documentId = cuid(),
  uploadId = cuid(),
  token = 'ab'.repeat(32)
let row: any, file: any, tx: any
beforeEach(() => {
  jest.clearAllMocks()
  row = {
    id,
    tokenHash: hashToken(token),
    status: 'OPEN',
    expiresAt: new Date(Date.now() + 60000),
    submittedAt: new Date(),
    uploadLeaseUntil: null,
  }
  file = { id: documentId, requestId: id, uploadId, status: 'READY', updatedAt: new Date(0), storagePath: 'private/file.pdf' }
  tx = {
    $executeRaw: jest.fn(),
    documentRequest: { findUnique: jest.fn(() => row) },
    documentRequestSubmissionFile: { count: jest.fn().mockResolvedValue(1) },
    documentRequestFile: {
      findUnique: jest.fn(() => file),
      findFirst: jest.fn(() => file),
      update: jest.fn(({ data }) => Object.assign(file, data)),
      updateMany: jest.fn(({ data }) => {
        Object.assign(file, data)
        return { count: 1 }
      }),
    },
    activityLog: { create: jest.fn() },
  }
  ;(prisma.$transaction as jest.Mock).mockImplementation(fn => fn(tx))
})
describe('submitted file retention', () => {
  test('removing a referenced document archives its immutable bytes', async () => {
    await deleteDocument(id, token, documentId)
    expect(file.status).toBe('ARCHIVED')
  })
  test('discarding referenced upload and replaying discard preserves ARCHIVED', async () => {
    await discardUpload(id, token, uploadId)
    await discardUpload(id, token, uploadId)
    expect(file.status).toBe('ARCHIVED')
    expect(tx.activityLog.create).toHaveBeenCalledTimes(1)
  })
  test('sweeper rechecks references under request lock even for a stale deleting candidate', async () => {
    file.status = 'DELETING'
    ;(prisma.documentRequestFile.findMany as jest.Mock).mockResolvedValue([file])
    await cleanupFiles()
    expect(deletePrivateFile).not.toHaveBeenCalled()
    expect(file.status).toBe('ARCHIVED')
  })
  test('regression: unreferenced files can still be discarded', async () => {
    tx.documentRequestSubmissionFile.count.mockResolvedValue(0)
    await discardUpload(id, token, uploadId)
    expect(file.status).toBe('DELETING')
  })
})
