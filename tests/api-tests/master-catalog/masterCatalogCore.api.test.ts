import express, { type Request, type Response } from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { prismaMock } from '@tests/__helpers__/setup'

const routeHits: string[] = []
const handler = (name: string) => (_req: Request, res: Response) => {
  routeHits.push(name)
  res.status(200).json({ success: true, data: { handler: name } })
}

jest.mock(
  '@/controllers/dashboard/masterCatalog.dashboard.controller',
  () => ({
    getAccess: handler('getAccess'),
    listItems: handler('listItems'),
    createItem: handler('createItem'),
    getItem: handler('getItem'),
    updateItem: handler('updateItem'),
    retireItem: handler('retireItem'),
    listValidationProfiles: handler('listValidationProfiles'),
    previewValidationProfile: handler('previewValidationProfile'),
    confirmValidationProfile: handler('confirmValidationProfile'),
    listBrands: handler('listBrands'),
    createBrand: handler('createBrand'),
    updateBrand: handler('updateBrand'),
    retireBrand: handler('retireBrand'),
    listManufacturers: handler('listManufacturers'),
    createManufacturer: handler('createManufacturer'),
    updateManufacturer: handler('updateManufacturer'),
    retireManufacturer: handler('retireManufacturer'),
    listFamilies: handler('listFamilies'),
    createFamily: handler('createFamily'),
    updateFamily: handler('updateFamily'),
    retireFamily: handler('retireFamily'),
    previewImport: handler('previewImport'),
    getImport: handler('getImport'),
    confirmImport: handler('confirmImport'),
    previewBindings: handler('previewBindings'),
    confirmBindings: handler('confirmBindings'),
    previewPublication: handler('previewPublication'),
    confirmPublication: handler('confirmPublication'),
    getPublicationByIdempotencyKey: handler('getPublicationByIdempotencyKey'),
    getPublication: handler('getPublication'),
    previewPublicationReversal: handler('previewPublicationReversal'),
    listPublications: handler('listPublications'),
    listAudit: handler('listAudit'),
    listAuditActions: handler('listAuditActions'),
    getVenueAccess: handler('getVenueAccess'),
    getVenueProvenance: handler('getVenueProvenance'),
    listVenueChanges: handler('listVenueChanges'),
    previewVenueOverride: handler('previewVenueOverride'),
    confirmVenueOverride: handler('confirmVenueOverride'),
  }),
  { virtual: true },
)

jest.mock(
  '@/controllers/superadmin/masterCatalog.superadmin.controller',
  () => ({
    listOrganizations: handler('listOrganizations'),
    getOrganization: handler('getOrganization'),
    updateEntitlement: handler('updateEntitlement'),
    updateModule: handler('updateModule'),
    updateConfig: handler('updateConfig'),
    updateGovernance: handler('updateGovernance'),
  }),
  { virtual: true },
)

import masterCatalogRoutes from '@/routes/dashboard/masterCatalog.routes'
import masterCatalogVenueRoutes from '@/routes/dashboard/masterCatalogVenue.routes'
import dashboardRoutes from '@/routes/dashboard.routes'
import superadminCatalogRoutes from '@/routes/superadmin/masterCatalog.routes'
import superadminRoutes from '@/routes/superadmin.routes'
import './masterCatalogRealAdapters.api'
import './masterCatalogProductionAuth.api'

const base = '/api/v1/dashboard/organizations/org-pits/master-catalog'

function token(): string {
  return jwt.sign({ sub: 'staff-owner', orgId: 'stale-org', venueId: 'stale-venue', role: 'OWNER' }, process.env.ACCESS_TOKEN_SECRET!, {
    algorithm: 'HS256',
    expiresIn: '1h',
  })
}

function app() {
  const server = express()
  server.use(express.json())
  server.use('/api/v1/dashboard/organizations/:orgId/master-catalog', masterCatalogRoutes)
  server.use((error: any, _req: Request, res: Response, _next: unknown) =>
    res.status(error.statusCode ?? 500).json({ message: error.message, code: error.code, details: error.details }),
  )
  return server
}

function dashboardApp() {
  const server = express()
  server.use(express.json())
  server.use('/api/v1/dashboard', dashboardRoutes)
  return server
}

function venueApp() {
  const server = express()
  server.use(express.json())
  server.use('/api/v1/dashboard/venues/:venueId/master-catalog', masterCatalogVenueRoutes)
  return server
}

function superadminApp(production = false) {
  const server = express()
  server.use(express.json())
  if (production) server.use('/api/v1/superadmin', superadminRoutes)
  else server.use('/api/v1/superadmin/master-catalog', superadminCatalogRoutes)
  return server
}

describe('H1A organization master-catalog route surface', () => {
  beforeEach(() => routeHits.splice(0))

  it('requires authentication on the mounted organization surface', async () => {
    await request(app()).get(`${base}/access`).expect(401)
    expect(routeHits).toEqual([])
  })

  it('is mounted by the production dashboard router at the exact organization path', async () => {
    const response = await request(dashboardApp()).get(`${base}/access`).set('Authorization', `Bearer ${token()}`).expect(200)

    expect(response.body.data.handler).toBe('getAccess')
  })

  it('routes the idempotency lookup before the dynamic publication batch route', async () => {
    const response = await request(app())
      .get(`${base}/publications/by-idempotency-key/CATALOG_FIELDS_PUBLISH/shared-key`)
      .set('Authorization', `Bearer ${token()}`)
      .expect(200)

    expect(response.body.data.handler).toBe('getPublicationByIdempotencyKey')
    expect(routeHits).toEqual(['getPublicationByIdempotencyKey'])
  })

  it('maps an unexpected multipart file field to the stable import input envelope', async () => {
    const response = await request(app())
      .post(`${base}/imports/preview`)
      .set('Authorization', `Bearer ${token()}`)
      .attach('unexpected', Buffer.from('not-an-xlsx'), 'input.xlsx')
      .expect(422)

    expect(response.body).toEqual(
      expect.objectContaining({
        code: 'CATALOG_IMPORT_REQUEST_INVALID',
        details: expect.objectContaining({ multerCode: 'LIMIT_UNEXPECTED_FILE' }),
      }),
    )
    expect(routeHits).toEqual([])
  })

  it.each([
    ['get', '/items', 'listItems'],
    ['post', '/items', 'createItem'],
    ['get', '/items/item-1', 'getItem'],
    ['patch', '/items/item-1', 'updateItem'],
    ['post', '/items/item-1/retire', 'retireItem'],
    ['get', '/validation-profiles', 'listValidationProfiles'],
    ['post', '/validation-profiles/preview', 'previewValidationProfile'],
    ['post', '/validation-profiles/profile-1/confirm', 'confirmValidationProfile'],
    ['get', '/catalogs/brands', 'listBrands'],
    ['post', '/catalogs/brands', 'createBrand'],
    ['patch', '/catalogs/brands/brand-1', 'updateBrand'],
    ['post', '/catalogs/brands/brand-1/retire', 'retireBrand'],
    ['get', '/catalogs/manufacturers', 'listManufacturers'],
    ['post', '/catalogs/manufacturers', 'createManufacturer'],
    ['patch', '/catalogs/manufacturers/manufacturer-1', 'updateManufacturer'],
    ['post', '/catalogs/manufacturers/manufacturer-1/retire', 'retireManufacturer'],
    ['get', '/catalogs/families', 'listFamilies'],
    ['post', '/catalogs/families', 'createFamily'],
    ['patch', '/catalogs/families/family-1', 'updateFamily'],
    ['post', '/catalogs/families/family-1/retire', 'retireFamily'],
    ['post', '/imports/preview', 'previewImport'],
    ['get', '/imports/import-1', 'getImport'],
    ['post', '/imports/import-1/confirm', 'confirmImport'],
    ['post', '/bindings/preview', 'previewBindings'],
    ['post', '/bindings/confirm', 'confirmBindings'],
    ['post', '/publications/preview', 'previewPublication'],
    ['post', '/publications/publication-1/confirm', 'confirmPublication'],
    ['post', '/publications/publication-1/reversal/preview', 'previewPublicationReversal'],
    ['get', '/publications', 'listPublications'],
    ['get', '/audit', 'listAudit'],
    ['get', '/audit/actions', 'listAuditActions'],
  ] as const)('%s %s reaches %s', async (method, path, expectedHandler) => {
    const response = await (request(app()) as any)[method](`${base}${path}`).set('Authorization', `Bearer ${token()}`).send({}).expect(200)

    expect(response.body.data.handler).toBe(expectedHandler)
  })
})

describe('H1A venue master-catalog route surface', () => {
  const venueBase = '/api/v1/dashboard/venues/venue-pits/master-catalog'

  beforeEach(() => routeHits.splice(0))

  it('requires authentication and is mounted by the production dashboard router', async () => {
    await request(venueApp()).get(`${venueBase}/access`).expect(401)
    expect(routeHits).toEqual([])

    const response = await request(dashboardApp()).get(`${venueBase}/access`).set('Authorization', `Bearer ${token()}`).expect(200)
    expect(response.body.data.handler).toBe('getVenueAccess')
  })

  it.each([
    ['get', '/access', 'getVenueAccess'],
    ['get', '/products/product-1/provenance', 'getVenueProvenance'],
    ['get', '/changes', 'listVenueChanges'],
    ['post', '/override-requests/preview', 'previewVenueOverride'],
    ['post', '/override-requests/request-1/confirm', 'confirmVenueOverride'],
  ] as const)('%s %s reaches %s', async (method, path, expectedHandler) => {
    const client = request(venueApp()) as any
    const response = await client[method](`${venueBase}${path}`).set('Authorization', `Bearer ${token()}`).send({}).expect(200)
    expect(response.body.data.handler).toBe(expectedHandler)
  })
})

describe('H1A superadmin master-catalog route surface', () => {
  const adminBase = '/api/v1/superadmin/master-catalog'
  const adminToken = () =>
    jwt.sign({ sub: 'staff-root', orgId: 'platform', venueId: 'platform', role: 'SUPERADMIN' }, process.env.ACCESS_TOKEN_SECRET!, {
      algorithm: 'HS256',
      expiresIn: '1h',
    })

  it('is mounted only beneath the authenticated production superadmin router', async () => {
    await request(superadminApp(true)).get(`${adminBase}/organizations`).expect(401)

    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'membership-superadmin' })
    const response = await request(superadminApp(true))
      .get(`${adminBase}/organizations`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .expect(200)
    expect(response.body.data.handler).toBe('listOrganizations')
  })

  it.each([
    ['get', '/master-catalog/organizations', 'listOrganizations'],
    ['get', '/master-catalog/organizations/org-pits', 'getOrganization'],
    ['put', '/master-catalog/organizations/org-pits/entitlement', 'updateEntitlement'],
    ['put', '/master-catalog/organizations/org-pits/module', 'updateModule'],
    ['put', '/master-catalog/organizations/org-pits/config', 'updateConfig'],
    ['put', '/master-catalog/organizations/org-pits/venues/venue-pits/governance', 'updateGovernance'],
  ] as const)('%s %s reaches %s', async (method, path, expectedHandler) => {
    const client = request(superadminApp()) as any
    const response = await client[method](`/api/v1/superadmin${path}`).set('Authorization', `Bearer ${adminToken()}`).send({}).expect(200)
    expect(response.body.data.handler).toBe(expectedHandler)
  })
})
