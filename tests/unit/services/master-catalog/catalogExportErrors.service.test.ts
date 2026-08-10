import * as XLSX from 'xlsx'
import { CATALOG_EXPORT_HYDRATED_ROW_CAP_V1, createCatalogExportService } from '@/services/master-catalog/catalogExport.service'
import { createCatalogExportErrorsService } from '@/services/master-catalog/catalogExportErrors.service'

const generatedAt = new Date('2026-08-09T12:34:56.000Z')
const context = {
  organizationId: 'org-pits',
  actor: { type: 'HUMAN' as const, staffId: 'staff-reader', impersonating: false },
}

function rows(buffer: Buffer, sheetName: string): unknown[][] {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellNF: true })
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, defval: null }) as unknown[][]
}

function durableError(index: number) {
  return {
    section: 'ERRORS',
    sourceSheet: 'Items',
    sourceRow: index + 2,
    ordinal: index + 1,
    status: 'INVALID',
    truncatedFields: [],
    column: 'corporate_sku',
    errorCode: 'VALUE_INVALID',
    message: `error-${index}`,
    rejectedValue: null,
    suggestion: null,
  }
}

describe('catalog export template and durable errors', () => {
  it('emits the exact Task7 input template with seven authoritative metadata keys', async () => {
    const tx = {
      catalogValidationProfile: {
        findMany: jest.fn().mockResolvedValue([{ profileVersion: 5 }, { profileVersion: 2 }, { profileVersion: 5 }]),
      },
    }
    const prisma = { $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) }
    const file = await createCatalogExportService({ prisma: prisma as never, now: () => generatedAt }).catalogImportTemplate(context)
    const workbook = XLSX.read(file.buffer, { type: 'buffer' })

    expect(file.filename).toBe('catalog-master-import-v1.xlsx')
    expect(workbook.SheetNames).toEqual(['Metadata', 'Items', 'OrganizationValues', 'BusinessTypes', 'VenueBindingRequests'])
    expect(rows(file.buffer, 'Metadata')).toEqual([
      ['key', 'value'],
      ['documentType', 'catalog-master-import'],
      ['filters', '{}'],
      ['generatedAt', generatedAt.toISOString()],
      ['organizationId', 'org-pits'],
      ['profileVersion', '2,5'],
      ['schemaVersion', '1'],
      ['timezone', 'America/Mexico_City'],
    ])
    expect(rows(file.buffer, 'Items')[0]).toEqual([
      'operation',
      'catalog_item_id',
      'expected_revision',
      'corporate_sku',
      'item_kind',
      'name',
      'description',
      'image_url',
      'brand',
      'manufacturer',
      'family',
      'subfamily',
      'presentation',
      'unit',
      'product_type',
      'iva_rate',
      'sat_product_key',
      'sat_unit_key',
      'objeto_imp',
      'ieps_mode',
      'ieps_rate',
      'ieps_quota',
      'ieps_quota_unit',
    ])
    expect(tx.catalogValidationProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-pits', active: true },
        select: { id: true, profileVersion: true },
        take: CATALOG_EXPORT_HYDRATED_ROW_CAP_V1 + 1,
      }),
    )
  })

  it('exports distinct durable findings at one coordinate with snapshot-only profile versions', async () => {
    const rejectedValue = `=${'x'.repeat(200)}`
    const durableRows = [
      {
        section: 'ERRORS',
        sourceSheet: 'Items',
        sourceRow: 2,
        ordinal: 2,
        status: 'INVALID',
        truncatedFields: [],
        column: 'corporate_sku',
        errorCode: 'VALUE_ALREADY_EXISTS',
        message: '=Already exists',
        rejectedValue,
        suggestion: '@Choose another',
      },
      {
        section: 'ERRORS',
        sourceSheet: 'Items',
        sourceRow: 2,
        ordinal: 1,
        status: 'INVALID',
        truncatedFields: [],
        column: 'corporate_sku',
        errorCode: 'CATALOG_WORKBOOK_DUPLICATE',
        message: '+Duplicate',
        rejectedValue: '0001',
        suggestion: '-Remove row',
      },
    ]
    const listErrorsPage = jest.fn().mockResolvedValue({ rows: durableRows, nextCursor: null })
    const readSnapshotProfileVersions = jest.fn().mockResolvedValue([3, 2, 3])
    const file = await createCatalogExportErrorsService({
      listErrorsPage: listErrorsPage as never,
      readSnapshotProfileVersions: readSnapshotProfileVersions as never,
      now: () => generatedAt,
    }).catalogImportErrors(context, 'batch-001')

    expect(file.filename).toBe('import-errors-v1.xlsx')
    expect(rows(file.buffer, 'Metadata')).toEqual([
      ['key', 'value'],
      ['filters', '{"importBatchId":"batch-001"}'],
      ['generatedAt', generatedAt.toISOString()],
      ['organizationId', 'org-pits'],
      ['profileVersion', '2,3'],
      ['schemaVersion', '1'],
      ['timezone', 'America/Mexico_City'],
    ])
    expect(rows(file.buffer, 'Errors')).toEqual([
      ['source_sheet', 'source_row', 'column', 'error_code', 'message', 'rejected_value', 'suggestion'],
      ['Items', 2, 'corporate_sku', 'CATALOG_WORKBOOK_DUPLICATE', "'+Duplicate", '0001', "'-Remove row"],
      ['Items', 2, 'corporate_sku', 'VALUE_ALREADY_EXISTS', "'=Already exists", `'=${'x'.repeat(127)}`, "'@Choose another"],
    ])
    expect(listErrorsPage).toHaveBeenCalledWith(context, { importBatchId: 'batch-001', section: 'ERRORS', pageSize: 50, cursor: null })
    expect(readSnapshotProfileVersions).toHaveBeenCalledWith(context, 'batch-001')
  })

  it('rejects an identical durable error grain instead of dropping truth', async () => {
    const duplicate = {
      section: 'ERRORS',
      sourceSheet: 'Items',
      sourceRow: 2,
      ordinal: 1,
      status: 'INVALID',
      truncatedFields: [],
      column: 'corporate_sku',
      errorCode: 'DUPLICATE',
      message: 'one',
      rejectedValue: null,
      suggestion: null,
    }
    const service = createCatalogExportErrorsService({
      listErrorsPage: jest
        .fn()
        .mockResolvedValue({ rows: [duplicate, { ...duplicate, ordinal: 2, message: 'two' }], nextCursor: null }) as never,
      readSnapshotProfileVersions: jest.fn().mockResolvedValue([]) as never,
    })
    await expect(service.catalogImportErrors(context, 'batch-001')).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATALOG_IMPORT_ERRORS_DATA_INVALID',
    })
  })

  it('includes every valid live and durable profile version beyond the old 100-row assumption', async () => {
    const versions = Array.from({ length: 152 }, (_, index) => index + 1)
    const tx = {
      catalogValidationProfile: { findMany: jest.fn().mockResolvedValue(versions.map(profileVersion => ({ profileVersion }))) },
    }
    const prisma = { $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) }
    const template = await createCatalogExportService({ prisma: prisma as never, now: () => generatedAt }).catalogImportTemplate(context)
    expect(rows(template.buffer, 'Metadata')).toContainEqual(['profileVersion', versions.join(',')])

    const errors = await createCatalogExportErrorsService({
      listErrorsPage: jest.fn().mockResolvedValue({ rows: [], nextCursor: null }) as never,
      readSnapshotProfileVersions: jest.fn().mockResolvedValue(versions) as never,
      now: () => generatedAt,
    }).catalogImportErrors(context, 'batch-001')
    expect(rows(errors.buffer, 'Metadata')).toContainEqual(['profileVersion', versions.join(',')])
  })

  it('walks more than one bounded durable page and exports every grain once', async () => {
    const first = Array.from({ length: 50 }, (_, index) => durableError(index))
    const listErrorsPage = jest
      .fn()
      .mockResolvedValueOnce({ rows: first, nextCursor: 'cursor-50' })
      .mockResolvedValueOnce({ rows: [durableError(50)], nextCursor: null })
    const file = await createCatalogExportErrorsService({
      listErrorsPage: listErrorsPage as never,
      readSnapshotProfileVersions: jest.fn().mockResolvedValue([4]) as never,
      now: () => generatedAt,
    }).catalogImportErrors(context, 'batch-001')

    expect(rows(file.buffer, 'Errors')).toHaveLength(52)
    expect(listErrorsPage).toHaveBeenNthCalledWith(2, context, {
      importBatchId: 'batch-001',
      section: 'ERRORS',
      pageSize: 50,
      cursor: 'cursor-50',
    })
  })

  it('rejects 5001 durable findings before invoking the workbook writer', async () => {
    let offset = 0
    const listErrorsPage = jest.fn().mockImplementation(() => {
      const size = offset < 5_000 ? Math.min(50, 5_001 - offset) : 1
      const pageRows = Array.from({ length: size }, (_, index) => durableError(offset + index))
      offset += size
      return Promise.resolve({ rows: pageRows, nextCursor: offset < 5_001 ? `cursor-${offset}` : null })
    })
    const writeWorkbook = jest.fn().mockResolvedValue(Buffer.from('not-used'))
    const service = createCatalogExportErrorsService({
      listErrorsPage: listErrorsPage as never,
      readSnapshotProfileVersions: jest.fn().mockResolvedValue([1]) as never,
      writeWorkbook,
    })

    await expect(service.catalogImportErrors(context, 'batch-001')).rejects.toMatchObject({
      statusCode: 413,
      code: 'CATALOG_EXPORT_CAP_EXCEEDED',
    })
    expect(listErrorsPage).toHaveBeenCalledTimes(100)
    expect(writeWorkbook).not.toHaveBeenCalled()
  })

  it('rejects 5001 durable profile versions before paging findings', async () => {
    const listErrorsPage = jest.fn()
    const writeWorkbook = jest.fn().mockResolvedValue(Buffer.from('not-used'))
    const service = createCatalogExportErrorsService({
      listErrorsPage: listErrorsPage as never,
      readSnapshotProfileVersions: jest.fn().mockResolvedValue(Array.from({ length: 5_001 }, (_, index) => index + 1)) as never,
      writeWorkbook,
    })

    await expect(service.catalogImportErrors(context, 'batch-001')).rejects.toMatchObject({
      statusCode: 413,
      code: 'CATALOG_EXPORT_CAP_EXCEEDED',
    })
    expect(listErrorsPage).not.toHaveBeenCalled()
    expect(writeWorkbook).not.toHaveBeenCalled()
  })

  it('counts profile versions and durable findings against one 5000-row hydration budget', async () => {
    const listErrorsPage = jest.fn().mockResolvedValue({ rows: [durableError(0), durableError(1)], nextCursor: null })
    const writeWorkbook = jest.fn().mockResolvedValue(Buffer.from('not-used'))
    const service = createCatalogExportErrorsService({
      listErrorsPage: listErrorsPage as never,
      readSnapshotProfileVersions: jest.fn().mockResolvedValue(Array.from({ length: 4_999 }, (_, index) => index + 1)) as never,
      writeWorkbook,
    })

    await expect(service.catalogImportErrors(context, 'batch-001')).rejects.toMatchObject({
      statusCode: 413,
      code: 'CATALOG_EXPORT_CAP_EXCEEDED',
    })
    expect(listErrorsPage).toHaveBeenCalledTimes(1)
    expect(writeWorkbook).not.toHaveBeenCalled()
  })

  it('rejects a repeated cursor without looping or invoking the workbook writer', async () => {
    const listErrorsPage = jest
      .fn()
      .mockResolvedValueOnce({ rows: [durableError(0)], nextCursor: 'repeated' })
      .mockResolvedValueOnce({ rows: [durableError(1)], nextCursor: 'repeated' })
    const writeWorkbook = jest.fn().mockResolvedValue(Buffer.from('not-used'))
    const service = createCatalogExportErrorsService({
      listErrorsPage: listErrorsPage as never,
      readSnapshotProfileVersions: jest.fn().mockResolvedValue([]) as never,
      writeWorkbook,
    })

    await expect(service.catalogImportErrors(context, 'batch-001')).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATALOG_IMPORT_ERRORS_DATA_INVALID',
    })
    expect(listErrorsPage).toHaveBeenCalledTimes(2)
    expect(writeWorkbook).not.toHaveBeenCalled()
  })

  it('rejects an oversized durable page before invoking the workbook writer', async () => {
    const writeWorkbook = jest.fn().mockResolvedValue(Buffer.from('not-used'))
    const service = createCatalogExportErrorsService({
      listErrorsPage: jest
        .fn()
        .mockResolvedValue({ rows: Array.from({ length: 51 }, (_, index) => durableError(index)), nextCursor: null }) as never,
      readSnapshotProfileVersions: jest.fn().mockResolvedValue([]) as never,
      writeWorkbook,
    })

    await expect(service.catalogImportErrors(context, 'batch-001')).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATALOG_IMPORT_ERRORS_DATA_INVALID',
    })
    expect(writeWorkbook).not.toHaveBeenCalled()
  })
})
