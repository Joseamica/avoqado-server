/**
 * TEST-ONLY authorization harness for the future H1A organization URLs.
 *
 * Task 10 owns production mounting. This small Express app proves the full
 * JWT -> AuthContext -> route organization -> shared service mapping now, so
 * future controllers cannot trust body scope or turn dependency failures into
 * authorization denials.
 */
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { OrgRole, StaffRole } from '@prisma/client'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { authorizeCatalogRequest, findCatalogTenantChildOrThrow } from '@/services/master-catalog/catalogAuthorization.service'
import { MASTER_CATALOG_DEFAULT_CONFIG } from '@/types/master-catalog'

const ROUTE_ORGANIZATION_ID = 'org-route-pits'
const OTHER_ROUTE_ORGANIZATION_ID = 'org-route-missing'
const STAFF_ID = 'staff-effective-owner'
const ROUTE_PATTERN = '/api/v1/dashboard/organizations/:orgId/master-catalog'
const BASE_URL = `/api/v1/dashboard/organizations/${ROUTE_ORGANIZATION_ID}/master-catalog`

const organizationFindUnique = jest.fn()
const staffFindUnique = jest.fn()
const entitlementFindUnique = jest.fn()
const moduleFindUnique = jest.fn()
const catalogItemFindFirst = jest.fn()

const db = {
  organization: { findUnique: organizationFindUnique },
  staff: { findUnique: staffFindUnique },
  organizationEntitlement: { findUnique: entitlementFindUnique },
  module: { findUnique: moduleFindUnique },
  catalogItem: { findFirst: catalogItemFindFirst },
}

function liveStaff(role: OrgRole = OrgRole.OWNER) {
  return {
    active: true,
    organizations: [{ role, isActive: true, leftAt: null }],
    venues: [],
  }
}

function activeModule() {
  return {
    active: true,
    scope: 'ORGANIZATION_ONLY',
    defaultConfig: { ...MASTER_CATALOG_DEFAULT_CONFIG, catalogCoreEnabled: true },
    organizationModules: [{ enabled: true, config: {} }],
  }
}

function bearerToken(overrides: Record<string, unknown> = {}): string {
  return jwt.sign(
    {
      sub: STAFF_ID,
      // Deliberately stale: the route plus live membership must win.
      orgId: 'org-from-stale-jwt',
      venueId: 'venue-from-stale-jwt',
      role: StaffRole.CASHIER,
      ...overrides,
    },
    process.env.ACCESS_TOKEN_SECRET!,
    { algorithm: 'HS256', expiresIn: '1h' },
  )
}

function authorizationErrorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const candidate = error as { statusCode?: number; message?: string; code?: string }
  res.status(candidate.statusCode ?? 500).json({
    message: candidate.message ?? 'Error interno',
    ...(candidate.code ? { code: candidate.code } : {}),
  })
}

function buildAuthorizationHarness() {
  const app = express()
  app.use(express.json())

  // These are intentionally test-only handlers on the exact future URL; no
  // production router/controller is mounted before Task 10.
  app.get(`${ROUTE_PATTERN}/access`, authenticateTokenMiddleware, async (req, res, next) => {
    try {
      const context = await authorizeCatalogRequest({
        authContext: req.authContext,
        routeOrganizationId: req.params.orgId,
        capability: 'READ',
        requiredGate: 'CORE',
        prisma: db as never,
      })
      res.status(200).json({ success: true, data: context })
    } catch (error) {
      next(error)
    }
  })

  app.post(`${ROUTE_PATTERN}/items`, authenticateTokenMiddleware, async (req, res, next) => {
    try {
      const context = await authorizeCatalogRequest({
        authContext: req.authContext,
        routeOrganizationId: req.params.orgId,
        capability: 'COMMAND',
        commandCapability: 'MUTATE_CONTENT',
        requiredGate: 'CORE',
        prisma: db as never,
      })
      res.status(200).json({ success: true, data: context })
    } catch (error) {
      next(error)
    }
  })

  app.get(`${ROUTE_PATTERN}/items/:catalogItemId`, authenticateTokenMiddleware, async (req, res, next) => {
    try {
      await authorizeCatalogRequest({
        authContext: req.authContext,
        routeOrganizationId: req.params.orgId,
        capability: 'READ',
        requiredGate: 'CORE',
        prisma: db as never,
      })
      const item = await findCatalogTenantChildOrThrow({
        id: req.params.catalogItemId,
        organizationId: req.params.orgId,
        findScoped: where => catalogItemFindFirst({ where }),
      })
      res.status(200).json({ success: true, data: item })
    } catch (error) {
      next(error)
    }
  })

  app.use(authorizationErrorHandler)
  return app
}

const app = buildAuthorizationHarness()

beforeEach(() => {
  jest.clearAllMocks()
  organizationFindUnique.mockResolvedValue({ id: ROUTE_ORGANIZATION_ID })
  staffFindUnique.mockResolvedValue(liveStaff())
  entitlementFindUnique.mockResolvedValue({
    status: 'ACTIVE',
    startsAt: new Date('2026-08-01T00:00:00.000Z'),
    endsAt: null,
  })
  moduleFindUnique.mockResolvedValue(activeModule())
  catalogItemFindFirst.mockResolvedValue({ id: 'item-owned', organizationId: ROUTE_ORGANIZATION_ID })
})

describe('H1A Task 4 test-only organization authorization harness', () => {
  it('returns 401 without a JWT', async () => {
    await request(app).get(`${BASE_URL}/access`).expect(401)
  })

  it('returns 403 for a live MEMBER even though the token is authenticated', async () => {
    staffFindUnique.mockResolvedValue(liveStaff(OrgRole.MEMBER))

    const response = await request(app).get(`${BASE_URL}/access`).set('Authorization', `Bearer ${bearerToken()}`).expect(403)

    expect(response.body.code).toBe('ROLE_DENIED')
  })

  it('returns 404 for a deleted route organization before attempting membership resolution', async () => {
    organizationFindUnique.mockResolvedValue(null)

    const response = await request(app).get(`${BASE_URL}/access`).set('Authorization', `Bearer ${bearerToken()}`).expect(404)

    expect(response.body.message).toBe('Organización no encontrada')
    expect(staffFindUnique).not.toHaveBeenCalled()
  })

  it('uses a changed route parameter instead of the JWT or the nominal fixture tenant', async () => {
    organizationFindUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(where.id === ROUTE_ORGANIZATION_ID ? { id: ROUTE_ORGANIZATION_ID } : null),
    )
    const otherRouteUrl = `/api/v1/dashboard/organizations/${OTHER_ROUTE_ORGANIZATION_ID}/master-catalog`

    await request(app)
      .get(`${otherRouteUrl}/access`)
      .set('Authorization', `Bearer ${bearerToken({ orgId: ROUTE_ORGANIZATION_ID })}`)
      .expect(404)

    // A distinct route request proves Express, rather than a test fallback,
    // supplies the organization boundary to the authorization service.
    expect(organizationFindUnique).toHaveBeenCalledWith({
      where: { id: OTHER_ROUTE_ORGANIZATION_ID },
      select: { id: true },
    })
    expect(staffFindUnique).not.toHaveBeenCalled()
  })

  it.each([
    ['organization lookup', () => organizationFindUnique.mockRejectedValue(new Error('P1001 unavailable'))],
    ['access resolver', () => moduleFindUnique.mockRejectedValue(new Error('P2024 pool timeout'))],
  ])('returns 503 when the %s dependency is unavailable', async (_label, arrange) => {
    arrange()

    const response = await request(app).get(`${BASE_URL}/access`).set('Authorization', `Bearer ${bearerToken()}`).expect(503)

    expect(response.body.code).toBe('DEPENDENCY_UNAVAILABLE')
  })

  it('ignores a forged body organization and authorizes only the route tenant', async () => {
    const response = await request(app)
      .post(`${BASE_URL}/items`)
      .set('Authorization', `Bearer ${bearerToken({ orgId: 'org-forged-jwt', role: StaffRole.VIEWER })}`)
      .send({ organizationId: 'org-forged-body', name: 'Intento de cambio de scope' })
      .expect(200)

    expect(response.body.data).toMatchObject({
      organizationId: ROUTE_ORGANIZATION_ID,
      actor: { type: 'HUMAN', staffId: STAFF_ID, impersonating: false },
      orgRole: OrgRole.OWNER,
    })
    expect(staffFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          organizations: expect.objectContaining({
            where: { organizationId: ROUTE_ORGANIZATION_ID, isActive: true, leftAt: null },
          }),
        }),
      }),
    )
  })

  it('makes missing and foreign child IDs indistinguishable through one scoped query', async () => {
    catalogItemFindFirst.mockResolvedValue(null)

    const missing = await request(app).get(`${BASE_URL}/items/item-missing`).set('Authorization', `Bearer ${bearerToken()}`).expect(404)
    const foreign = await request(app).get(`${BASE_URL}/items/item-foreign`).set('Authorization', `Bearer ${bearerToken()}`).expect(404)

    expect(foreign.body).toEqual(missing.body)
    expect(catalogItemFindFirst.mock.calls.map(call => call[0])).toEqual([
      { where: { id: 'item-missing', organizationId: ROUTE_ORGANIZATION_ID } },
      { where: { id: 'item-foreign', organizationId: ROUTE_ORGANIZATION_ID } },
    ])
  })
})
