import express, { type Request, type Response } from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { OrgRole, StaffRole } from '@prisma/client'
import { MASTER_CATALOG_DEFAULT_CONFIG } from '@/types/master-catalog'

const organizationFindUnique = jest.fn()
const staffFindUnique = jest.fn()
const entitlementFindUnique = jest.fn()
const moduleFindUnique = jest.fn()
const listCatalogReferences = jest.fn()
const createCatalogBrand = jest.fn()

const db = {
  organization: { findUnique: organizationFindUnique },
  staff: { findUnique: staffFindUnique },
  organizationEntitlement: { findUnique: entitlementFindUnique },
  module: { findUnique: moduleFindUnique },
}

let router: import('express').Router

function liveStaff(role: OrgRole = OrgRole.OWNER, organizationId = 'org-pits') {
  return {
    active: true,
    organizations: [{ organizationId, role, isActive: true, leftAt: null }],
    venues: [],
  }
}

function activeModule(config: Record<string, unknown> = {}) {
  return {
    active: true,
    scope: 'ORGANIZATION_ONLY',
    defaultConfig: { ...MASTER_CATALOG_DEFAULT_CONFIG, catalogCoreEnabled: true },
    organizationModules: [{ enabled: true, config }],
  }
}

function token(act?: Record<string, unknown>) {
  return jwt.sign(
    {
      sub: 'staff-owner',
      orgId: 'stale-org',
      venueId: 'stale-venue',
      role: StaffRole.CASHIER,
      ...(act ? { act } : {}),
    },
    process.env.ACCESS_TOKEN_SECRET!,
    { algorithm: 'HS256', expiresIn: '1h' },
  )
}

function app() {
  const server = express()
  server.use(express.json())
  server.use('/organizations/:orgId/master-catalog', router)
  server.use((error: any, _req: Request, res: Response, _next: unknown) =>
    res.status(error.statusCode ?? 500).json({ message: error.message, code: error.code, details: error.details }),
  )
  return server
}

beforeAll(() => {
  jest.resetModules()
  jest.unmock('@/controllers/dashboard/masterCatalog.dashboard.controller')
  jest.unmock('@/services/master-catalog/catalogAuthorization.service')
  jest.unmock('@/services/master-catalog/masterCatalogAccess.service')
  jest.doMock('@/utils/prismaClient', () => ({ __esModule: true, default: db }))
  jest.doMock('@/utils/tokenRevocation', () => ({ isJtiRevoked: jest.fn().mockResolvedValue(false) }))
  jest.doMock('@/middlewares/impersonationGuard.middleware', () => ({
    enforceImpersonationRules: jest.fn().mockResolvedValue({ ok: true }),
  }))
  jest.doMock('@/services/liveDemo.service', () => ({ updateLiveDemoActivity: jest.fn().mockResolvedValue(undefined) }))
  jest.doMock('@/services/master-catalog/catalogItem.service', () => ({
    listCatalogItems: jest.fn(),
    getCatalogItem: jest.fn(),
    createCatalogItem: jest.fn(),
    updateCatalogItem: jest.fn(),
    retireCatalogItem: jest.fn(),
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
  jest.doMock('@/services/master-catalog/masterCatalogRead.service', () => ({
    getCatalogPublication: jest.fn(),
    listCatalogPublications: jest.fn(),
    getCatalogImport: jest.fn(),
    listCatalogValidationProfiles: jest.fn(),
    resolveCatalogVenueContext: jest.fn(),
    getCatalogVenueAccess: jest.fn(),
  }))
  jest.doMock('@/services/master-catalog/catalogPublication.service', () => ({
    catalogPublicationService: { preview: jest.fn(), confirm: jest.fn(), getByIdempotencyKey: jest.fn() },
  }))
  jest.doMock('@/services/master-catalog/catalogValidation.service', () => ({
    previewCatalogValidationProfile: jest.fn(),
    confirmCatalogValidationProfile: jest.fn(),
  }))
  jest.doMock('@/services/master-catalog/catalogImport.service', () => ({
    previewCatalogImport: jest.fn(),
    confirmCatalogImport: jest.fn(),
  }))
  jest.doMock('@/services/master-catalog/catalogBinding.service', () => ({
    previewCatalogBindings: jest.fn(),
    confirmCatalogBindings: jest.fn(),
  }))
  jest.doMock('@/services/master-catalog/catalogOverrideRead.service', () => ({
    getCatalogVenueProvenance: jest.fn(),
    listCatalogVenueChanges: jest.fn(),
  }))
  jest.doMock('@/services/master-catalog/catalogOverride.service', () => ({
    previewCatalogOverrideRequest: jest.fn(),
    confirmCatalogOverrideRequest: jest.fn(),
  }))
  jest.doMock('@/services/dashboard/activity-log.service', () => ({
    queryActivityLogs: jest.fn(),
    getDistinctActions: jest.fn(),
  }))
  router = require('@/routes/dashboard/masterCatalog.routes').default
})

beforeEach(() => {
  jest.clearAllMocks()
  organizationFindUnique.mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve({ id: where.id }))
  staffFindUnique.mockImplementation(({ select }: any) => {
    const organizationId = select.organizations.where.organizationId
    return Promise.resolve(organizationId === 'org-pits' ? liveStaff(OrgRole.OWNER) : { ...liveStaff(), organizations: [] })
  })
  entitlementFindUnique.mockResolvedValue({
    status: 'ACTIVE',
    startsAt: new Date('2026-08-01T00:00:00.000Z'),
    endsAt: null,
  })
  moduleFindUnique.mockResolvedValue(activeModule())
  listCatalogReferences.mockResolvedValue({ items: [], nextCursor: null })
  createCatalogBrand.mockResolvedValue({ id: 'brand-1' })
})

describe('production master-catalog authorization matrix', () => {
  it.each([OrgRole.OWNER, OrgRole.ADMIN])('allows %s to execute a production command', async role => {
    staffFindUnique.mockResolvedValue(liveStaff(role))

    await request(app())
      .post('/organizations/org-pits/master-catalog/catalogs/brands')
      .set('Authorization', `Bearer ${token()}`)
      .send({ name: 'Brand' })
      .expect(201)

    expect(createCatalogBrand).toHaveBeenCalledWith(expect.objectContaining({ orgRole: role }), { name: 'Brand' })
  })

  it('allows VIEWER reads but denies commands before the production service', async () => {
    staffFindUnique.mockResolvedValue(liveStaff(OrgRole.VIEWER))

    await request(app()).get('/organizations/org-pits/master-catalog/catalogs/brands').set('Authorization', `Bearer ${token()}`).expect(200)
    await request(app())
      .post('/organizations/org-pits/master-catalog/catalogs/brands')
      .set('Authorization', `Bearer ${token()}`)
      .send({ name: 'Brand' })
      .expect(403)

    expect(listCatalogReferences).toHaveBeenCalledTimes(1)
    expect(createCatalogBrand).not.toHaveBeenCalled()
  })

  it.each([
    ['MEMBER', liveStaff(OrgRole.MEMBER)],
    ['venue-only', { active: true, organizations: [], venues: [{ id: 'venue-pits', role: StaffRole.MANAGER, active: true }] }],
    ['inactive Staff', { ...liveStaff(), active: false }],
    ['revoked organization membership', { ...liveStaff(), organizations: [] }],
  ])('denies %s before a production read service', async (_label, staff) => {
    staffFindUnique.mockResolvedValue(staff)

    const response = await request(app())
      .get('/organizations/org-pits/master-catalog/catalogs/brands')
      .set('Authorization', `Bearer ${token()}`)
      .expect(403)

    expect(response.body.code).toBe('ROLE_DENIED')
    expect(listCatalogReferences).not.toHaveBeenCalled()
  })

  it('denies impersonated commands even for a live OWNER', async () => {
    const response = await request(app())
      .post('/organizations/org-pits/master-catalog/catalogs/brands')
      .set(
        'Authorization',
        `Bearer ${token({ sub: 'superadmin-real', role: StaffRole.SUPERADMIN, expiresAt: Math.floor(Date.now() / 1000) + 1800 })}`,
      )
      .send({ name: 'Brand' })
      .expect(403)

    expect(response.body.code).toBe('ROLE_DENIED')
    expect(createCatalogBrand).not.toHaveBeenCalled()
  })

  it('derives tenant from the route and denies a foreign organization membership', async () => {
    const response = await request(app())
      .get('/organizations/org-foreign/master-catalog/catalogs/brands')
      .set('Authorization', `Bearer ${token()}`)
      .expect(403)

    expect(response.body.code).toBe('ROLE_DENIED')
    expect(listCatalogReferences).not.toHaveBeenCalled()
    expect(staffFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          organizations: expect.objectContaining({ where: expect.objectContaining({ organizationId: 'org-foreign' }) }),
        }),
      }),
    )
  })

  it.each([
    ['gate off', () => moduleFindUnique.mockResolvedValue(activeModule({ catalogCoreEnabled: false })), 'GATE_DISABLED', 403],
    ['unknown config', () => moduleFindUnique.mockResolvedValue(activeModule({ unknownGate: true })), 'CONFIG_INVALID', 403],
    ['dependency outage', () => moduleFindUnique.mockRejectedValue(new Error('P2024')), 'DEPENDENCY_UNAVAILABLE', 503],
  ])('fails closed for %s before a production read service', async (_label, arrange, code, status) => {
    arrange()

    const response = await request(app())
      .get('/organizations/org-pits/master-catalog/catalogs/brands')
      .set('Authorization', `Bearer ${token()}`)
      .expect(status)

    expect(response.body.code).toBe(code)
    expect(listCatalogReferences).not.toHaveBeenCalled()
  })
})
