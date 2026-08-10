import { catalogImportConfirmRequestSchema, catalogImportPreviewRequestSchema } from '@/schemas/dashboard/masterCatalogImport.schema'

const upload = {
  fieldname: 'file',
  originalname: 'catalog-master-import-v1.xlsx',
  encoding: '7bit',
  mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  size: 8,
  buffer: Buffer.from('PK\u0003\u0004test', 'binary'),
  destination: '/forged',
}

describe('master catalog import dashboard request schemas', () => {
  it('projects only trusted preview route and in-memory upload fields', () => {
    const parsed = catalogImportPreviewRequestSchema.parse({
      params: { orgId: 'org-pits', forged: 'ignored' },
      file: upload,
      body: { organizationId: 'org-forged' },
    })

    expect(parsed).toEqual({
      params: { orgId: 'org-pits' },
      file: {
        originalname: 'catalog-master-import-v1.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        buffer: upload.buffer,
      },
    })
  })

  it.each([
    ['missing file', { params: { orgId: 'org-pits' } }],
    ['non-buffer upload', { params: { orgId: 'org-pits' }, file: { ...upload, buffer: 'PK' } }],
    ['blank organization', { params: { orgId: '   ' }, file: upload }],
    ['oversized organization ID', { params: { orgId: 'o'.repeat(257) }, file: upload }],
  ])('rejects %s before workbook parsing', (_label, input) => {
    expect(catalogImportPreviewRequestSchema.safeParse(input).success).toBe(false)
  })

  it('projects only the route authority and opaque confirmation factors', () => {
    const parsed = catalogImportConfirmRequestSchema.parse({
      params: { orgId: 'org-pits', importBatchId: 'batch-1', forged: 'ignored' },
      body: {
        previewToken: ' opaque-token ',
        confirm: true,
        idempotencyKey: ' opaque-key ',
        organizationId: 'org-forged',
        importBatchId: 'batch-forged',
      },
    })

    expect(parsed).toEqual({
      params: { orgId: 'org-pits', importBatchId: 'batch-1' },
      body: { previewToken: ' opaque-token ', confirm: true, idempotencyKey: ' opaque-key ' },
    })
  })

  it.each([
    ['missing acknowledgement', { previewToken: 'token', idempotencyKey: 'key' }],
    ['false acknowledgement', { previewToken: 'token', confirm: false, idempotencyKey: 'key' }],
    ['blank bearer', { previewToken: '', confirm: true, idempotencyKey: 'key' }],
    ['oversized bearer', { previewToken: 't'.repeat(513), confirm: true, idempotencyKey: 'key' }],
    ['blank idempotency key', { previewToken: 'token', confirm: true, idempotencyKey: '   ' }],
    ['oversized idempotency key', { previewToken: 'token', confirm: true, idempotencyKey: 'k'.repeat(201) }],
  ])('rejects %s', (_label, body) => {
    expect(
      catalogImportConfirmRequestSchema.safeParse({
        params: { orgId: 'org-pits', importBatchId: 'batch-1' },
        body,
      }).success,
    ).toBe(false)
  })

  it('uses bounded Spanish diagnostics at the HTTP boundary', () => {
    const result = catalogImportConfirmRequestSchema.safeParse({
      params: { orgId: '', importBatchId: '' },
      body: { previewToken: '', confirm: false, idempotencyKey: '' },
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map(issue => issue.message)).toEqual(
        expect.arrayContaining([
          'La organización es requerida.',
          'El batch de importación es requerido.',
          'El token de preview es requerido.',
          'Debes confirmar explícitamente la importación.',
          'La llave de idempotencia es requerida.',
        ]),
      )
    }
  })
})
