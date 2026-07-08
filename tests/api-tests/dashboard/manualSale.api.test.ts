/*
  API tests for the org-scoped "Subir ventas fuera de TPV" endpoints:
    POST /api/v1/dashboard/organizations/:orgId/manual-sales/preview
    POST /api/v1/dashboard/organizations/:orgId/manual-sales

  These assert the HTTP WIRING + GUARDS that the service-layer unit tests
  (Task 4 = createOneManualSale, Task 5 = bulkManualSales) cannot reach:

    (a) OWNER → preview → 200, passes through the mocked service result,
        service invoked with apply=false.
    (b) OWNER → apply   → 200, service invoked with apply=true.
    (c) non-OWNER role  → 403 (requireOrgOwner runs before the service).
    (d) invalid body (rows: []) → 400 from validateRequest(bulkManualSalesSchema).
    (e) org whose venues lack the SERIALIZED_INVENTORY module → 403 from the
        controller's module gate (moduleService.isModuleEnabled → false).

  Pattern follows the sibling api-tests (manualPayment/creditPack): Prisma is
  globally mocked via tests/__helpers__/setup.ts (prismaMock). The bulkManualSales
  SERVICE is mocked here (its real behavior — row classification, cross-org ICCID,
  dedup, DB writes — is covered by the Task 4/5 unit tests), so these tests focus
  purely on routing, auth/permission gating, the module gate, and request/response
  shape. moduleService.isModuleEnabled is mocked to drive the module gate both ways.

  NOTE ON DB TARGET: `npm run test:api` runs under tests/__helpers__/setup.ts,
  which globally mocks @/utils/prismaClient — NO real database is contacted. These
  tests deliberately do NOT assert DB rows (SerializedItem SOLD / SaleVerification
  COMPLETED); that lands in the Task 4/5 unit tests against the mocked Prisma create
  calls. This keeps the api-test track free of any real-DB dependency.
*/

import request from 'supertest'
import jwt from 'jsonwebtoken'
import type { Express } from 'express'
import { prismaMock } from '@tests/__helpers__/setup'

// Mock the bulkManualSales service — the controller is the unit under test here.
jest.mock('@/services/dashboard/manualSale.service', () => ({
  __esModule: true,
  bulkManualSales: jest.fn(),
}))

// Mock the module service so we can flip the SERIALIZED_INVENTORY gate per-test.
// MODULE_CODES must stay a real object (the controller reads MODULE_CODES.SERIALIZED_INVENTORY).
jest.mock('@/services/modules/module.service', () => ({
  __esModule: true,
  MODULE_CODES: {
    SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY',
    ATTENDANCE_TRACKING: 'ATTENDANCE_TRACKING',
    WHITE_LABEL_DASHBOARD: 'WHITE_LABEL_DASHBOARD',
    COMMISSIONS: 'COMMISSIONS',
  },
  moduleService: {
    isModuleEnabled: jest.fn(),
  },
}))

// These are (re)bound in beforeAll AFTER `@/app` is imported. Because beforeAll
// calls jest.resetModules() and then re-imports the app, the mock factories run a
// SECOND time and produce fresh jest.fn()s — the controller closes over THOSE. If
// we captured the mocks at top-level import (pre-reset) we'd be configuring stale
// fns the controller never calls. So we grab them post-reset via requireMock.
let bulkManualSalesMock: jest.Mock
let isModuleEnabledMock: jest.Mock

let app: Express
const TEST_SECRET = 'test-secret'

// CUID-ish ids for realism.
const ORG_ID = 'cltestorgmanualsale012345'
const VENUE_ID = 'cltestvenuemanualsale0123'
const STAFF_ID = 'cltestusermanualsale01234'

const BASE = `/api/v1/dashboard/organizations/${ORG_ID}/manual-sales`

beforeAll(async () => {
  process.env.NODE_ENV = process.env.NODE_ENV || 'test'
  process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || TEST_SECRET
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session'
  process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie'
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb'

  jest.resetModules()

  // Bypass express-session middleware (not relevant to these routes).
  jest.mock('@/config/session', () => ({
    __esModule: true,
    default: (_req: any, _res: any, next: any) => next(),
  }))

  const mod = await import('@/app')
  app = mod.default

  // Bind to the POST-reset mock instances the controller actually closes over.
  const svc = jest.requireMock('@/services/dashboard/manualSale.service') as { bulkManualSales: jest.Mock }
  const modSvc = jest.requireMock('@/services/modules/module.service') as { moduleService: { isModuleEnabled: jest.Mock } }
  bulkManualSalesMock = svc.bulkManualSales
  isModuleEnabledMock = modSvc.moduleService.isModuleEnabled
})

/**
 * JWT matching AvoqadoJwtPayload — authContext.userId = sub. The token venueId is
 * present but never matches a URL param (these are org routes); checkPermission's
 * resolveRequestVenueId falls back to authContext.venueId, and because
 * tokenVenueId === targetVenueId the role resolves straight from the token
 * (source 'token') without a StaffVenue lookup.
 */
const makeToken = (role: string) =>
  jwt.sign({ sub: STAFF_ID, orgId: ORG_ID, venueId: VENUE_ID, role }, process.env.ACCESS_TOKEN_SECRET || TEST_SECRET)

const validRow = {
  iccid: '8952140061234567890',
  storeName: 'BAE Unidad Pavón',
  saleDate: '2026-07-01',
  saleType: 'Línea nueva',
  paymentForm: 'Efectivo',
  amount: '150.00',
  promoterCode: 'P-001',
  simType: 'SIM Bait',
}

const previewResult = {
  crear: [{ index: 0, iccid: validRow.iccid, storeName: validRow.storeName }],
  omitir: [],
  error: [],
}

beforeEach(() => {
  // checkPermission probes for a SUPERADMIN StaffVenue and a custom
  // VenueRolePermission — default both to null so only the token role drives
  // access (no accidental SUPERADMIN fallthrough, no custom-perm override).
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
  // requireOrgOwner: default to an active OWNER StaffOrganization row (overridden
  // per-test for the non-owner case).
  prismaMock.staffOrganization.findFirst.mockResolvedValue({ id: 'orgmembership1' })
  // Module gate: the controller lists the org's venues, then checks each. Return
  // one venue so the loop reaches isModuleEnabled; enable the module by default.
  prismaMock.venue.findMany.mockResolvedValue([{ id: VENUE_ID }])
  isModuleEnabledMock.mockResolvedValue(true)
  bulkManualSalesMock.mockReset()
})

// ==========================================================================
// (a) OWNER preview → 200, service called with apply=false
// ==========================================================================

describe('POST /organizations/:orgId/manual-sales/preview', () => {
  it('200: OWNER preview returns the classified result and calls the service with apply=false', async () => {
    bulkManualSalesMock.mockResolvedValue(previewResult)

    const token = makeToken('OWNER')
    const res = await request(app)
      .post(`${BASE}/preview`)
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: [validRow] })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data).toEqual(previewResult)

    expect(bulkManualSalesMock).toHaveBeenCalledTimes(1)
    const [orgIdArg, actorArg, rowsArg, applyArg] = bulkManualSalesMock.mock.calls[0]
    expect(orgIdArg).toBe(ORG_ID)
    expect(actorArg).toBe(STAFF_ID) // authContext.userId, NOT req.user
    expect(rowsArg).toHaveLength(1)
    expect(rowsArg[0].iccid).toBe(validRow.iccid)
    expect(applyArg).toBe(false) // preview = dry run
  })

  it('403: a non-OWNER role is blocked by requireOrgOwner before the service runs', async () => {
    // requireOrgOwner finds no active OWNER StaffOrganization → 403.
    prismaMock.staffOrganization.findFirst.mockResolvedValue(null)

    const token = makeToken('MANAGER')
    const res = await request(app)
      .post(`${BASE}/preview`)
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: [validRow] })

    expect(res.status).toBe(403)
    expect(bulkManualSalesMock).not.toHaveBeenCalled()
  })

  it('400: an empty rows array fails validateRequest(bulkManualSalesSchema) with a Spanish message', async () => {
    const token = makeToken('OWNER')
    const res = await request(app).post(`${BASE}/preview`).set('Authorization', `Bearer ${token}`).send({ rows: [] })

    expect(res.status).toBe(400)
    // Zod message from the schema: 'Sube al menos una venta'
    const msg = res.body.message || res.body.error || ''
    expect(msg).toMatch(/al menos una venta/i)
    expect(bulkManualSalesMock).not.toHaveBeenCalled()
  })

  it('403: an org whose venues lack the SERIALIZED_INVENTORY module is blocked by the controller module gate', async () => {
    isModuleEnabledMock.mockResolvedValue(false)

    const token = makeToken('OWNER')
    const res = await request(app)
      .post(`${BASE}/preview`)
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: [validRow] })

    expect(res.status).toBe(403)
    expect(res.body.success).toBe(false)
    expect(res.body.error).toBe('Módulo de inventario serializado no habilitado')
    expect(bulkManualSalesMock).not.toHaveBeenCalled()
  })
})

// ==========================================================================
// (b) OWNER apply → 200, service called with apply=true
// ==========================================================================

describe('POST /organizations/:orgId/manual-sales', () => {
  it('200: OWNER apply creates the sales and calls the service with apply=true', async () => {
    const applyResult = { ...previewResult, created: 1 }
    bulkManualSalesMock.mockResolvedValue(applyResult)

    const token = makeToken('OWNER')
    const res = await request(app)
      .post(BASE)
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: [validRow], confirm: true })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data).toEqual(applyResult)
    expect(res.body.data.created).toBe(1)

    expect(bulkManualSalesMock).toHaveBeenCalledTimes(1)
    const [orgIdArg, actorArg, rowsArg, applyArg] = bulkManualSalesMock.mock.calls[0]
    expect(orgIdArg).toBe(ORG_ID)
    expect(actorArg).toBe(STAFF_ID)
    expect(rowsArg).toHaveLength(1)
    expect(applyArg).toBe(true) // apply = writes
  })

  it('403: a non-OWNER role cannot apply (requireOrgOwner)', async () => {
    prismaMock.staffOrganization.findFirst.mockResolvedValue(null)

    const token = makeToken('CASHIER')
    const res = await request(app)
      .post(BASE)
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: [validRow], confirm: true })

    expect(res.status).toBe(403)
    expect(bulkManualSalesMock).not.toHaveBeenCalled()
  })

  it('403: apply is blocked when the org lacks the SERIALIZED_INVENTORY module', async () => {
    isModuleEnabledMock.mockResolvedValue(false)

    const token = makeToken('OWNER')
    const res = await request(app)
      .post(BASE)
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: [validRow], confirm: true })

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Módulo de inventario serializado no habilitado')
    expect(bulkManualSalesMock).not.toHaveBeenCalled()
  })
})
