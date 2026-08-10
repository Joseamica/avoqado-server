import express, { type Request, type Response } from 'express'
import jwt from 'jsonwebtoken'
import request, { type Response as SupertestResponse } from 'supertest'
import { ForbiddenError, NotFoundError } from '@/errors/AppError'

const authorizeCatalogRequest = jest.fn()
const listCatalogItems = jest.fn()
const getCatalogItem = jest.fn()
const createCatalogItem = jest.fn()
const listCatalogReferences = jest.fn()
const createCatalogBrand = jest.fn()
const getDistinctActions = jest.fn()
const resolveCatalogVenueContext = jest.fn()
const getCatalogVenueAccess = jest.fn()
const getCatalogVenueProvenance = jest.fn()
const previewCatalogImport = jest.fn()
const previewCatalogValidationProfile = jest.fn()
const previewCatalogBindings = jest.fn()
const previewCatalogOverrideRequest = jest.fn()
const catalogPublicationService = { preview: jest.fn(), confirm: jest.fn(), getByIdempotencyKey: jest.fn() }
const masterCatalogControlPlaneService = {
  listOrganizations: jest.fn(),
  getOrganization: jest.fn(),
  updateEntitlement: jest.fn(),
  updateModule: jest.fn(),
  updateConfig: jest.fn(),
  updateGovernance: jest.fn(),
}
let router: import('express').Router
let venueRouter: import('express').Router
let superadminRouter: import('express').Router

beforeAll(() => {
  jest.resetModules()
  jest.unmock('@/controllers/dashboard/masterCatalog.dashboard.controller')
  jest.unmock('@/controllers/superadmin/masterCatalog.superadmin.controller')
  jest.doMock('@/services/master-catalog/catalogAuthorization.service', () => ({ authorizeCatalogRequest }))
  jest.doMock('@/services/master-catalog/catalogItem.service', () => ({
    listCatalogItems,
    getCatalogItem,
    createCatalogItem,
    updateCatalogItem: jest.fn(),
    retireCatalogItem: jest.fn(),
  }))
  jest.doMock('@/services/master-catalog/masterCatalogAccess.service', () => ({ resolveMasterCatalogAccess: jest.fn() }))
  jest.doMock('@/services/master-catalog/masterCatalogRead.service', () => ({
    getCatalogPublication: jest.fn(),
    listCatalogPublications: jest.fn(),
    getCatalogImport: jest.fn(),
    listCatalogValidationProfiles: jest.fn(),
    resolveCatalogVenueContext,
    getCatalogVenueAccess,
  }))
  jest.doMock('@/services/master-catalog/catalogPublication.service', () => ({
    catalogPublicationService,
  }))
  jest.doMock('@/services/master-catalog/catalogReference.service', () => ({
    listCatalogReferences,
    createCatalogBrand,
    createCatalogManufacturer: jest.fn(),
    createCatalogFamily: jest.fn(),
    updateCatalogBrand: jest.fn(),
    updateCatalogManufacturer: jest.fn(),
    updateCatalogFamily: jest.fn(),
    retireCatalogBrand: jest.fn(),
    retireCatalogManufacturer: jest.fn(),
    retireCatalogFamily: jest.fn(),
  }))
  jest.doMock('@/services/master-catalog/catalogValidation.service', () => ({
    previewCatalogValidationProfile,
    confirmCatalogValidationProfile: jest.fn(),
  }))
  jest.doMock('@/services/master-catalog/catalogImport.service', () => ({ previewCatalogImport, confirmCatalogImport: jest.fn() }))
  jest.doMock('@/services/master-catalog/catalogBinding.service', () => ({ previewCatalogBindings, confirmCatalogBindings: jest.fn() }))
  jest.doMock('@/services/master-catalog/catalogOverrideRead.service', () => ({
    getCatalogVenueProvenance,
    listCatalogVenueChanges: jest.fn(),
  }))
  jest.doMock('@/services/master-catalog/catalogOverride.service', () => ({
    previewCatalogOverrideRequest,
    confirmCatalogOverrideRequest: jest.fn(),
  }))
  jest.doMock('@/services/dashboard/activity-log.service', () => ({ queryActivityLogs: jest.fn(), getDistinctActions }))
  jest.doMock('@/services/master-catalog/masterCatalogControlPlane.service', () => ({ masterCatalogControlPlaneService }))
  router = require('@/routes/dashboard/masterCatalog.routes').default
  venueRouter = require('@/routes/dashboard/masterCatalogVenue.routes').default
  superadminRouter = require('@/routes/superadmin/masterCatalog.routes').default
})

function token() {
  return jwt.sign({ sub: 'staff-owner', orgId: 'stale', venueId: 'stale', role: 'OWNER' }, process.env.ACCESS_TOKEN_SECRET!, {
    algorithm: 'HS256',
    expiresIn: '1h',
  })
}

function app() {
  const server = express()
  server.use(express.json())
  server.use('/organizations/:orgId/master-catalog', router)
  server.use('/venues/:venueId/master-catalog', venueRouter)
  server.use(
    '/superadmin/master-catalog',
    (req, _res, next) => {
      req.authContext = { userId: 'staff-owner', role: 'SUPERADMIN' } as never
      next()
    },
    superadminRouter,
  )
  server.use((error: any, _req: Request, res: Response, _next: unknown) =>
    res.status(error.statusCode ?? 500).json({ message: error.message, code: error.code, details: error.details }),
  )
  return server
}

describe('production master-catalog controller adapters', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    authorizeCatalogRequest.mockResolvedValue({
      organizationId: 'org-pits',
      actor: { type: 'HUMAN', staffId: 'staff-owner', impersonating: false },
      orgRole: 'OWNER',
    })
    listCatalogItems.mockResolvedValue({ items: [], nextCursor: null })
    listCatalogReferences.mockResolvedValue({ items: [], nextCursor: null })
    previewCatalogImport.mockResolvedValue({ importBatchId: 'import-1', previewToken: 'preview-token' })
    createCatalogItem.mockResolvedValue({ id: 'item-1' })
    createCatalogBrand.mockResolvedValue({ id: 'brand-1' })
    previewCatalogValidationProfile.mockResolvedValue({ profileBatchId: 'profile-1' })
    previewCatalogBindings.mockResolvedValue({ bindingBatchId: 'binding-1' })
    catalogPublicationService.preview.mockResolvedValue({ publicationBatchId: 'publication-1' })
    previewCatalogOverrideRequest.mockResolvedValue({ requestBatchId: 'override-1' })
    resolveCatalogVenueContext.mockResolvedValue({
      organizationId: 'org-pits',
      venueId: 'venue-pits',
      actor: { type: 'HUMAN', staffId: 'staff-owner', impersonating: false },
    })
  })

  it('coerces query strings before invoking the shared item service', async () => {
    await request(app())
      .get('/organizations/org-pits/master-catalog/items?pageSize=2')
      .set('Authorization', `Bearer ${token()}`)
      .expect(200)
    expect(listCatalogItems).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-pits' }), { pageSize: 2 })
  })

  it('rejects forged query scope without invoking the item service', async () => {
    await request(app())
      .get('/organizations/org-pits/master-catalog/items?organizationId=org-foreign')
      .set('Authorization', `Bearer ${token()}`)
      .expect(422)
    expect(listCatalogItems).not.toHaveBeenCalled()
  })

  it.each([
    ['/catalogs/brands', 'BRAND'],
    ['/catalogs/manufacturers', 'MANUFACTURER'],
    ['/catalogs/families', 'FAMILY'],
  ])('coerces the shared reference query for %s', async (path, referenceType) => {
    await request(app())
      .get(`/organizations/org-pits/master-catalog${path}?pageSize=2`)
      .set('Authorization', `Bearer ${token()}`)
      .expect(200)
    expect(listCatalogReferences).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-pits' }), {
      pageSize: 2,
      referenceType,
    })
  })

  it('preserves gate/impersonation denial and cross-tenant not-found envelopes', async () => {
    authorizeCatalogRequest.mockRejectedValueOnce(new ForbiddenError('Acceso al catálogo denegado', 'GATE_DISABLED'))
    await request(app()).get('/organizations/org-pits/master-catalog/items').set('Authorization', `Bearer ${token()}`).expect(403, {
      message: 'Acceso al catálogo denegado',
      code: 'GATE_DISABLED',
    })

    getCatalogItem.mockRejectedValueOnce(new NotFoundError('Artículo de catálogo no encontrado.'))
    await request(app())
      .get('/organizations/org-pits/master-catalog/items/foreign-item')
      .set('Authorization', `Bearer ${token()}`)
      .expect(404)
  })

  it('runs a valid workbook through real Multer and the production import controller', async () => {
    await request(app())
      .post('/organizations/org-pits/master-catalog/imports/preview')
      .set('Authorization', `Bearer ${token()}`)
      .attach('file', Buffer.from('workbook-bytes'), {
        filename: 'catalog.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      .expect(200)
    expect(previewCatalogImport).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-pits' }),
      expect.objectContaining({
        buffer: expect.any(Buffer),
        originalFilename: 'catalog.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    )
  })

  it.each([
    ['unexpected file field', (call: any) => call.attach('workbook', Buffer.from('x'), 'catalog.xlsx')],
    ['oversized file', (call: any) => call.attach('file', Buffer.alloc(10 * 1024 * 1024 + 1), 'catalog.xlsx')],
  ])('maps %s through real Multer to the stable import envelope', async (_label, attach) => {
    const call = request(app()).post('/organizations/org-pits/master-catalog/imports/preview').set('Authorization', `Bearer ${token()}`)
    await attach(call)
      .expect(422)
      .expect((response: SupertestResponse) => expect(response.body.code).toBe('CATALOG_IMPORT_REQUEST_INVALID'))
    expect(previewCatalogImport).not.toHaveBeenCalled()
  })

  it('rejects organization scope forged in multipart fields before the import service', async () => {
    await request(app())
      .post('/organizations/org-pits/master-catalog/imports/preview')
      .set('Authorization', `Bearer ${token()}`)
      .field('organizationId', 'org-foreign')
      .attach('file', Buffer.from('x'), 'catalog.xlsx')
      .expect(422, { message: 'La organización sólo puede venir de la ruta', code: 'CATALOG_SCOPE_FORGED' })
    expect(previewCatalogImport).not.toHaveBeenCalled()
  })

  it('maps a truncated multipart stream to the stable import envelope', async () => {
    await request(app())
      .post('/organizations/org-pits/master-catalog/imports/preview')
      .set('Authorization', `Bearer ${token()}`)
      .set('Content-Type', 'multipart/form-data; boundary=x')
      .send('--x\r\nContent-Disposition: form-data; name="file"; filename="a.xlsx"\r\n\r\nabc')
      .expect(422, {
        message: 'Solicitud multipart de catálogo no válida',
        code: 'CATALOG_IMPORT_REQUEST_INVALID',
        details: { parserCode: 'UNEXPECTED_END_OF_FORM' },
      })
    expect(previewCatalogImport).not.toHaveBeenCalled()
  })

  const validItem = () => ({
    sku: 'CORP-1',
    kind: 'RETAIL_PRODUCT',
    name: 'Item',
    description: 'Description',
    imageUrl: 'https://example.test/item.png',
    brandId: 'brand-1',
    manufacturerId: 'manufacturer-1',
    familyId: 'family-1',
    presentationLabel: '1 piece',
    unit: 'PIECE',
    taxRate: '0.1600',
    satProductKey: '50161500',
    satUnitKey: 'H87',
    objetoImp: '02',
    productType: 'REGULAR',
    iepsMode: 'NONE',
    iepsRate: null,
    iepsQuota: null,
    iepsQuotaUnit: null,
    businessTypes: ['RETAIL_STORE'],
    organizationValues: [
      { kind: 'SALE_PRICE', amount: '10.00', currency: 'MXN' },
      { kind: 'PURCHASE_COST', amount: '6.00', currency: 'MXN' },
    ],
  })

  it.each([
    ['/organizations/org-pits/master-catalog/items', () => ({ ...validItem(), unexpected: true }), createCatalogItem],
    [
      '/organizations/org-pits/master-catalog/items',
      () => ({ ...validItem(), organizationValues: [{ ...validItem().organizationValues[0], unexpected: true }] }),
      createCatalogItem,
    ],
    ['/organizations/org-pits/master-catalog/catalogs/brands', () => ({ name: 'Brand', unexpected: true }), createCatalogBrand],
    [
      '/organizations/org-pits/master-catalog/validation-profiles/preview',
      () => ({ idempotencyKey: 'profile-key', name: 'Profile', requiredFields: ['sku'], unexpected: true }),
      previewCatalogValidationProfile,
    ],
    [
      '/organizations/org-pits/master-catalog/bindings/preview',
      () => ({ lines: [{ catalogItemId: 'item-1', venueId: 'venue-pits', unexpected: true }] }),
      previewCatalogBindings,
    ],
    [
      '/organizations/org-pits/master-catalog/publications/preview',
      () => ({
        operation: 'CATALOG_FIELDS_PUBLISH',
        idempotencyKey: 'publication-key',
        targets: [{ catalogItemId: 'item-1', venueId: 'venue-pits', productId: 'product-1', unexpected: true }],
      }),
      catalogPublicationService.preview,
    ],
    [
      '/venues/venue-pits/master-catalog/override-requests/preview',
      () => ({
        bindingId: 'binding-1',
        idempotencyKey: 'override-key',
        requests: [{ field: 'name', reason: 'Local requirement', unexpected: true }],
      }),
      previewCatalogOverrideRequest,
    ],
  ])('rejects unknown command fields before the shared service on %s', async (path, payload, service) => {
    await request(app()).post(path).set('Authorization', `Bearer ${token()}`).send(payload()).expect(422)
    expect(service).not.toHaveBeenCalled()
  })

  it('binds reversal targets to the publication batch from the production route', async () => {
    await request(app())
      .post('/organizations/org-pits/master-catalog/publications/batch-a/reversal/preview')
      .set('Authorization', `Bearer ${token()}`)
      .send({
        idempotencyKey: 'reversal-key',
        targets: [{ catalogItemId: 'item-1', venueId: 'venue-pits', productId: 'product-1', sourceLineId: 'line-from-batch-b' }],
      })
      .expect(200)
    expect(catalogPublicationService.preview).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-pits' }),
      expect.objectContaining({
        operation: 'CATALOG_FIELDS_REVERSION',
        sourcePublicationBatchId: 'batch-a',
        targets: [expect.objectContaining({ sourceLineId: 'line-from-batch-b' })],
      }),
    )
  })

  it.each([
    ['/organizations/org-pits/master-catalog/items/item-1?organizationId=org-foreign', getCatalogItem],
    ['/organizations/org-pits/master-catalog/audit/actions?orgId=org-foreign', getDistinctActions],
    ['/venues/venue-pits/master-catalog/access?venueId=venue-foreign', getCatalogVenueAccess],
    ['/venues/venue-pits/master-catalog/products/product-1/provenance?organizationId=org-foreign', getCatalogVenueProvenance],
  ])('rejects route-scope forgery before production controller services on %s', async (path, service) => {
    await request(app()).get(path).set('Authorization', `Bearer ${token()}`).expect(422, {
      message: 'El scope sólo puede venir de la ruta',
      code: 'CATALOG_SCOPE_FORGED',
    })
    expect(service).not.toHaveBeenCalled()
  })

  it('rejects unknown query keys on an endpoint with no query contract', async () => {
    await request(app())
      .get('/organizations/org-pits/master-catalog/items/item-1?wat=1')
      .set('Authorization', `Bearer ${token()}`)
      .expect(422)
    expect(getCatalogItem).not.toHaveBeenCalled()
  })

  it.each([
    ['get', '/superadmin/master-catalog/organizations?orgId=org-foreign', 'listOrganizations'],
    ['get', '/superadmin/master-catalog/organizations/org-pits?orgId=org-foreign', 'getOrganization'],
    ['put', '/superadmin/master-catalog/organizations/org-pits/entitlement?orgId=org-foreign', 'updateEntitlement'],
    ['put', '/superadmin/master-catalog/organizations/org-pits/module?orgId=org-foreign', 'updateModule'],
    ['put', '/superadmin/master-catalog/organizations/org-pits/config?orgId=org-foreign', 'updateConfig'],
    ['put', '/superadmin/master-catalog/organizations/org-pits/venues/venue-pits/governance?venueId=venue-foreign', 'updateGovernance'],
  ])('rejects forged superadmin query scope for %s %s', async (method, path, serviceName) => {
    await (request(app()) as any)[method](path).send({}).expect(422, {
      message: 'El scope sólo puede venir de la ruta',
      code: 'CATALOG_SCOPE_FORGED',
    })
    expect(masterCatalogControlPlaneService[serviceName as keyof typeof masterCatalogControlPlaneService]).not.toHaveBeenCalled()
  })
})
