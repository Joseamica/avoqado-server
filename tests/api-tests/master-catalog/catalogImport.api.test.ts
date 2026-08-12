/**
 * TEST-ONLY multipart harness for H1A Task 7.
 *
 * Task 10 owns the production controller/Multer mount. This app freezes the
 * planned URL, route-derived organization, upload shape, and confirm schema
 * without exposing an early production endpoint.
 */
import express, { type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'
import request from 'supertest'
import { catalogImportConfirmRequestSchema, catalogImportPreviewRequestSchema } from '@/schemas/dashboard/masterCatalogImport.schema'
import { confirmCatalogImport, previewCatalogImport } from '@/services/master-catalog/catalogImport.service'

jest.mock('@/services/master-catalog/catalogImport.service', () => ({
  previewCatalogImport: jest.fn(),
  confirmCatalogImport: jest.fn(),
}))

const previewMock = previewCatalogImport as jest.MockedFunction<typeof previewCatalogImport>
const confirmMock = confirmCatalogImport as jest.MockedFunction<typeof confirmCatalogImport>
const route = '/api/v1/dashboard/organizations/:orgId/master-catalog/imports'
const base = '/api/v1/dashboard/organizations/org-route-pits/master-catalog/imports'
const xlsxMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

function testOnlyAuthentication(req: Request, res: Response, next: NextFunction): void {
  // WHY: This harness exercises route/service composition only; Task 4 already
  // freezes JWT/live membership and Task 10 repeats both against the real app.
  if (req.header('authorization') !== 'Bearer test-owner') {
    res.status(401).json({ message: 'No autenticado' })
    return
  }
  req.authContext = {
    userId: 'staff-owner',
    orgId: 'org-stale-token',
    venueId: 'venue-stale-token',
    role: 'OWNER' as never,
    isImpersonating: false,
  }
  next()
}

function parseOrRespond<T>(result: { success: true; data: T } | { success: false; error: { issues: unknown[] } }, res: Response): T | null {
  if (result.success) return result.data
  res
    .status(400)
    .json({ message: 'Solicitud de importación inválida', code: 'CATALOG_IMPORT_REQUEST_INVALID', details: result.error.issues })
  return null
}

function buildHarness() {
  const app = express()
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } })
  app.use(express.json())

  app.post(`${route}/preview`, testOnlyAuthentication, upload.single('file'), async (req, res, next) => {
    try {
      const parsed = parseOrRespond(catalogImportPreviewRequestSchema.safeParse({ params: req.params, file: req.file }), res)
      if (!parsed) return
      const result = await previewCatalogImport(
        {
          organizationId: parsed.params.orgId,
          actor: { type: 'HUMAN', staffId: req.authContext!.userId, impersonating: false },
          orgRole: 'OWNER',
        },
        {
          buffer: parsed.file.buffer,
          mimeType: parsed.file.mimetype,
          originalFilename: parsed.file.originalname,
        },
      )
      res.status(200).json({ success: true, data: result })
    } catch (error) {
      next(error)
    }
  })

  app.post(`${route}/:importBatchId/confirm`, testOnlyAuthentication, async (req, res, next) => {
    try {
      const parsed = parseOrRespond(catalogImportConfirmRequestSchema.safeParse({ params: req.params, body: req.body }), res)
      if (!parsed) return
      const result = await confirmCatalogImport(
        {
          organizationId: parsed.params.orgId,
          actor: { type: 'HUMAN', staffId: req.authContext!.userId, impersonating: false },
          orgRole: 'OWNER',
        },
        { importBatchId: parsed.params.importBatchId, ...parsed.body },
      )
      res.status(200).json({ success: true, data: result })
    } catch (error) {
      next(error)
    }
  })

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const safe = error as { statusCode?: number; code?: string; message?: string }
    res.status(safe.statusCode ?? 500).json({ message: safe.message ?? 'Error interno', ...(safe.code ? { code: safe.code } : {}) })
  })
  return app
}

const app = buildHarness()

beforeEach(() => {
  jest.clearAllMocks()
  previewMock.mockResolvedValue({
    importBatchId: 'import-batch-1',
    canConfirm: true,
    previewToken: 'preview-token',
    targetHash: 'a'.repeat(64),
    expiresAt: '2026-08-08T20:30:00.000Z',
    errors: [],
  } as never)
  confirmMock.mockResolvedValue({ importBatchId: 'import-batch-1', state: 'APPLIED', appliedItemIds: [] } as never)
})

describe('H1A Task 7 test-only master catalog import API harness', () => {
  it('requires authentication and a single multipart file on the exact planned URL', async () => {
    await request(app).post(`${base}/preview`).expect(401)
    const missing = await request(app).post(`${base}/preview`).set('Authorization', 'Bearer test-owner').expect(400)
    expect(missing.body.code).toBe('CATALOG_IMPORT_REQUEST_INVALID')
    expect(previewMock).not.toHaveBeenCalled()
  })

  it('derives organization and actor from route/auth while forwarding only bounded upload metadata', async () => {
    const bytes = Buffer.from('PK\u0003\u0004test-xlsx', 'binary')

    const response = await request(app)
      .post(`${base}/preview`)
      .set('Authorization', 'Bearer test-owner')
      .field('organizationId', 'org-forged-body')
      .attach('file', bytes, { filename: 'catalog-master-import-v1.xlsx', contentType: xlsxMime })
      .expect(200)

    expect(response.body.data.importBatchId).toBe('import-batch-1')
    expect(previewMock).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-route-pits',
        actor: { type: 'HUMAN', staffId: 'staff-owner', impersonating: false },
      }),
      { buffer: bytes, mimeType: xlsxMime, originalFilename: 'catalog-master-import-v1.xlsx' },
    )
  })

  it.each([
    ['confirm omitted', { previewToken: 'token', idempotencyKey: 'key' }],
    ['confirm false', { previewToken: 'token', confirm: false, idempotencyKey: 'key' }],
    ['token blank', { previewToken: '', confirm: true, idempotencyKey: 'key' }],
    ['idempotency blank', { previewToken: 'token', confirm: true, idempotencyKey: '   ' }],
  ])('rejects %s before the confirmation service', async (_label, body) => {
    await request(app).post(`${base}/import-batch-1/confirm`).set('Authorization', 'Bearer test-owner').send(body).expect(400)
    expect(confirmMock).not.toHaveBeenCalled()
  })

  it('passes only route batch ID, opaque token, literal confirmation, and idempotency key', async () => {
    await request(app)
      .post(`${base}/import-batch-1/confirm`)
      .set('Authorization', 'Bearer test-owner')
      .send({
        importBatchId: 'forged-body-batch',
        organizationId: 'forged-body-org',
        previewToken: 'opaque-preview-token',
        confirm: true,
        idempotencyKey: 'opaque-idempotency-key',
      })
      .expect(200)

    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-route-pits' }), {
      importBatchId: 'import-batch-1',
      previewToken: 'opaque-preview-token',
      confirm: true,
      idempotencyKey: 'opaque-idempotency-key',
    })
  })
})
