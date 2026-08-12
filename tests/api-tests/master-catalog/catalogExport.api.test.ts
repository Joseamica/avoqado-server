import express, { type Request, type Response } from 'express'
import jwt from 'jsonwebtoken'
import request, { type Response as SupertestResponse } from 'supertest'
import * as XLSX from 'xlsx'
import { BusinessType, OrgRole, StaffRole } from '@prisma/client'
import { MASTER_CATALOG_DEFAULT_CONFIG } from '@/types/master-catalog'

const organizationFindUnique = jest.fn()
const staffFindUnique = jest.fn()
const entitlementFindUnique = jest.fn()
const moduleFindUnique = jest.fn()
const profileFindMany = jest.fn()
const itemFindMany = jest.fn()
const relationFindMany = jest.fn()
const queryRaw = jest.fn()

const db: Record<string, unknown> = {
  organization: { findUnique: organizationFindUnique },
  staff: { findUnique: staffFindUnique },
  organizationEntitlement: { findUnique: entitlementFindUnique },
  module: { findUnique: moduleFindUnique },
  catalogValidationProfile: { findMany: profileFindMany },
  catalogItem: { findMany: itemFindMany },
  catalogItemPrice: { findMany: relationFindMany },
  catalogItemBusinessType: { findMany: relationFindMany },
  catalogVenueBinding: { findMany: relationFindMany },
  catalogIdentifier: { findMany: relationFindMany },
  recipeLine: { findMany: relationFindMany },
  $queryRaw: queryRaw,
}
Object.assign(db, { $transaction: jest.fn(async (work: (tx: typeof db) => unknown) => work(db)) })

let router: import('express').Router

function token(): string {
  return jwt.sign(
    { sub: 'staff-owner', orgId: 'stale-org', venueId: 'stale-venue', role: StaffRole.CASHIER },
    process.env.ACCESS_TOKEN_SECRET!,
    { algorithm: 'HS256', expiresIn: '1h' },
  )
}

function binaryParser(res: SupertestResponse, done: (error: Error | null, body?: Buffer) => void): void {
  const chunks: Buffer[] = []
  res.on('data', chunk => chunks.push(Buffer.from(chunk)))
  res.on('end', () => done(null, Buffer.concat(chunks)))
  res.on('error', done)
}

function app() {
  const server = express()
  server.use('/organizations/:orgId/master-catalog', router)
  server.use((error: any, _req: Request, res: Response, _next: unknown) =>
    res.status(error.statusCode ?? 500).json({ message: error.message, code: error.code, details: error.details }),
  )
  return server
}

function workbook(response: SupertestResponse): XLSX.WorkBook {
  return XLSX.read((response as SupertestResponse & { body: Buffer }).body, { type: 'buffer' })
}

function durableBatch(staffId = 'staff-owner') {
  return {
    id: 'batch-001',
    organizationId: 'org-pits',
    schemaVersion: 1,
    targetHash: 'a'.repeat(64),
    previewTokenHash: 'b'.repeat(64),
    staffId,
    state: 'FAILED',
    previewExpiresAt: new Date('2026-08-09T14:00:00.000Z'),
    lineCount: '1',
    itemCount: '1',
    capacityIntegrityValid: true,
    invalidLineCount: '0',
    invalidPayloadCount: '0',
    oversizedSheetCount: '0',
    capacitySchemaVersion: '1',
    capacityCostModelVersion: '1',
    capacityMeasurement: 'EXACT',
    capacityWorkUnits: '32',
    capacityLimit: '12000',
    capacityWithinLimit: 'true',
    capacityBase: '32',
    capacityReferences: '0',
    capacityCreates: '0',
    capacityUpdates: '0',
    capacityRetires: '0',
    capacityValues: '0',
    capacityDeactivations: '0',
  }
}

function arrangeDurableErrors(staffId = 'staff-owner'): void {
  queryRaw
    .mockResolvedValueOnce([durableBatch(staffId)])
    .mockResolvedValueOnce([{ batchId: 'batch-001', collectionShapeValid: true, ordinal: 1, rowShapeValid: true, profileVersion: '4' }])
    .mockResolvedValueOnce([durableBatch(staffId)])
    .mockResolvedValueOnce([
      {
        sourceSheet: 'Items',
        sourceRow: '2',
        ordinal: 1,
        cursorSourceSheet: 'Items',
        cursorSourceRow: 2,
        durableShapeValid: true,
        status: 'INVALID',
        column: 'corporate_sku',
        errorCode: 'VALUE_ALREADY_EXISTS',
        message: 'Already exists',
        rejectedValue: '0001',
        suggestion: 'Choose another',
      },
    ])
}

beforeAll(() => {
  jest.resetModules()
  jest.unmock('@/controllers/dashboard/masterCatalog.dashboard.controller')
  jest.unmock('@/services/master-catalog/catalogAuthorization.service')
  jest.unmock('@/services/master-catalog/masterCatalogAccess.service')
  jest.unmock('@/services/master-catalog/catalogExport.service')
  jest.doMock('@/utils/prismaClient', () => ({ __esModule: true, default: db }))
  jest.doMock('@/utils/tokenRevocation', () => ({ isJtiRevoked: jest.fn().mockResolvedValue(false) }))
  jest.doMock('@/middlewares/impersonationGuard.middleware', () => ({
    enforceImpersonationRules: jest.fn().mockResolvedValue({ ok: true }),
  }))
  jest.doMock('@/services/liveDemo.service', () => ({ updateLiveDemoActivity: jest.fn().mockResolvedValue(undefined) }))
  router = require('@/routes/dashboard/masterCatalog.routes').default
})

beforeEach(() => {
  jest.clearAllMocks()
  organizationFindUnique.mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve({ id: where.id }))
  staffFindUnique.mockImplementation(({ select }: any) => {
    const organizationId = select.organizations.where.organizationId
    return Promise.resolve({
      active: true,
      organizations:
        organizationId === 'org-pits' ? [{ organizationId: 'org-pits', role: OrgRole.OWNER, isActive: true, leftAt: null }] : [],
      venues: [],
    })
  })
  entitlementFindUnique.mockResolvedValue({ status: 'ACTIVE', startsAt: new Date('2026-08-01T00:00:00.000Z'), endsAt: null })
  moduleFindUnique.mockResolvedValue({
    active: true,
    scope: 'ORGANIZATION_ONLY',
    defaultConfig: { ...MASTER_CATALOG_DEFAULT_CONFIG, catalogCoreEnabled: true },
    organizationModules: [{ enabled: true, config: {} }],
  })
  profileFindMany.mockResolvedValue([])
  itemFindMany.mockResolvedValue([])
  relationFindMany.mockResolvedValue([])
})

describe('catalog XLSX production routes', () => {
  it.each([
    [
      '/exports/catalog-master.xlsx',
      'catalog-master-v1.xlsx',
      [
        'Metadata',
        'Items',
        'OrganizationValues',
        'BusinessTypes',
        'VenueBindings',
        'PreparedDishDetails',
        'Identifiers',
        'Regions',
        'RegionalValues',
      ],
    ],
    [
      `/exports/catalog-by-business-type.xlsx?businessType=${BusinessType.RESTAURANT}`,
      'catalog-by-business-type-v1.xlsx',
      [
        'Metadata',
        'Items',
        'OrganizationValues',
        'BusinessTypes',
        'VenueBindings',
        'PreparedDishDetails',
        'Identifiers',
        'Regions',
        'RegionalValues',
        'RequiredFields',
      ],
    ],
    [
      '/templates/catalog-master-import-v1.xlsx',
      'catalog-master-import-v1.xlsx',
      ['Metadata', 'Items', 'OrganizationValues', 'BusinessTypes', 'VenueBindingRequests'],
    ],
  ] as const)('serves %s through production auth/controller as a real XLSX', async (path, filename, sheetNames) => {
    const response = await request(app())
      .get(`/organizations/org-pits/master-catalog${path}`)
      .set('Authorization', `Bearer ${token()}`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200)

    expect(response.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(response.headers['content-disposition']).toBe(`attachment; filename="${filename}"`)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(workbook(response).SheetNames).toEqual(sheetNames)
  })

  it('serves durable import errors through the original actor and a real XLSX parse', async () => {
    arrangeDurableErrors()

    const response = await request(app())
      .get('/organizations/org-pits/master-catalog/imports/batch-001/errors.xlsx')
      .set('Authorization', `Bearer ${token()}`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200)

    expect(response.headers['content-disposition']).toBe('attachment; filename="import-errors-v1.xlsx"')
    const parsed = workbook(response)
    expect(parsed.SheetNames).toEqual(['Metadata', 'Errors'])
    expect(XLSX.utils.sheet_to_json(parsed.Sheets.Errors, { header: 1, raw: true })).toContainEqual([
      'Items',
      2,
      'corporate_sku',
      'VALUE_ALREADY_EXISTS',
      'Already exists',
      '0001',
      'Choose another',
    ])
  })

  it('requires authentication and derives tenant membership from the route before querying export data', async () => {
    await request(app()).get('/organizations/org-pits/master-catalog/exports/catalog-master.xlsx').expect(401)

    const denied = await request(app())
      .get('/organizations/org-foreign/master-catalog/exports/catalog-master.xlsx')
      .set('Authorization', `Bearer ${token()}`)
      .expect(403)

    expect(denied.body.code).toBe('ROLE_DENIED')
    expect(itemFindMany).not.toHaveBeenCalled()
    expect(profileFindMany).not.toHaveBeenCalled()
  })

  it.each([
    ['/exports/catalog-master.xlsx?organizationId=org-foreign', 'CATALOG_SCOPE_FORGED'],
    ['/exports/catalog-master.xlsx?extra=true', 'CATALOG_REQUEST_INVALID'],
    ['/exports/catalog-by-business-type.xlsx', 'CATALOG_REQUEST_INVALID'],
    ['/exports/catalog-by-business-type.xlsx?businessType=UNKNOWN', 'CATALOG_REQUEST_INVALID'],
  ])('rejects malformed or forged export query %s before database hydration', async (path, code) => {
    const response = await request(app())
      .get(`/organizations/org-pits/master-catalog${path}`)
      .set('Authorization', `Bearer ${token()}`)
      .expect(422)

    expect(response.body.code).toBe(code)
    expect(itemFindMany).not.toHaveBeenCalled()
  })

  it('does not reveal durable import errors to a different live actor', async () => {
    arrangeDurableErrors('staff-other')

    const response = await request(app())
      .get('/organizations/org-pits/master-catalog/imports/batch-001/errors.xlsx')
      .set('Authorization', `Bearer ${token()}`)
      .expect(403)

    expect(response.body.code).toBe('CATALOG_IMPORT_ACTOR_MISMATCH')
  })
})
