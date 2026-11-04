/**
 * CRM sabotage — against a real Postgres, the real JWT and the whole app through supertest (spec 2026-10-30 §5.1,
 * Ruling 3).
 *
 * A seller is a VIEWER of the internal venue and holds EVERY `crm:*` key. Those keys open `/api/v1/crm` and nothing else:
 * with the same token, everything superadmin-only and everything of another business answers 403. The global Prisma
 * mock of the unit project cannot prove this — the real guards (`authorizeRole`, `checkPermission`) must read a real
 * database.
 *
 * Run with:
 *   TEST_DATABASE_URL='postgresql://postgres:<password>@localhost:5432/avoqado_crm_test_<date>' \
 *     npx jest --selectProjects=integration --runTestsByPath tests/integration/crm/sabotaje.integration.test.ts --ci
 */
import type { Server } from 'http'
import { StaffRole } from '@prisma/client'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import { generateImpersonationAccessToken } from '@/jwt.service'
import prisma from '@/utils/prismaClient'

const suffix = `crm${Date.now()}`
const email = `seller-${suffix}@test.mx`

describe('CRM: a seller with every crm:* key is still a VIEWER outside the CRM', () => {
  let server: Server
  let orgId: string | undefined
  let venueId: string | undefined
  let otherOrgId: string | undefined
  let otherVenueId: string | undefined
  let staffId: string | undefined
  let token: string
  let impersonationToken: string

  beforeAll(async () => {
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(done => server.once('listening', () => done()))

    orgId = (await prisma.organization.create({ data: { name: `Prime ${suffix}`, email: `prime-${suffix}@test.mx`, phone: '5555555555' } }))
      .id
    venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `Sales team ${suffix}`, slug: `sales-${suffix}` } })).id
    otherOrgId = (
      await prisma.organization.create({ data: { name: `Client ${suffix}`, email: `client-${suffix}@test.mx`, phone: '5555555555' } })
    ).id
    otherVenueId = (await prisma.venue.create({ data: { organizationId: otherOrgId, name: `Client ${suffix}`, slug: `client-${suffix}` } }))
      .id

    staffId = (await prisma.staff.create({ data: { email, firstName: 'Seller', lastName: 'Sabotage', emailVerified: true } })).id
    await prisma.staffVenue.create({ data: { staffId, venueId, role: StaffRole.VIEWER, active: true } })
    await prisma.platformAccess.create({
      data: {
        email,
        verScope: 'todos',
        editarScope: 'todos',
        contactar: true,
        campanas: true,
        exportar: true,
        ventas: true,
        admin: true,
        // Las 8 llaves finas (plan 2026-11-04): con ellas tiene TODAS.
        cerrar: true,
        bajas: true,
        plantillas: true,
        preparar: true,
        mandar: true,
        verCampanas: true,
        equipo: true,
        configurar: true,
        createdById: staffId,
      },
    })

    token = jwt.sign({ sub: staffId, orgId, venueId, role: StaffRole.VIEWER }, process.env.ACCESS_TOKEN_SECRET as string, {
      expiresIn: '15m',
    })
    // A superadmin impersonating this seller (user mode): the effective identity (`sub`) is the seller, who holds every
    // key. The actor id is never looked up on this path, so it needs no row.
    impersonationToken = generateImpersonationAccessToken(staffId, orgId, venueId, StaffRole.VIEWER, {
      sub: 'csuperadminactor000000001',
      role: StaffRole.SUPERADMIN,
      mode: 'user',
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      extensionsUsed: 0,
    })
  })

  afterAll(async () => {
    try {
      // Every delete is keyed by something this file created: a `where` with an undefined value would wipe the table.
      await prisma.platformAccess.deleteMany({ where: { email } })
      if (staffId) {
        await prisma.staffVenue.deleteMany({ where: { staffId } })
        await prisma.staff.deleteMany({ where: { id: staffId } })
      }
      const venues = [venueId, otherVenueId].filter((id): id is string => !!id)
      if (venues.length) await prisma.venue.deleteMany({ where: { id: { in: venues } } })
      const orgs = [orgId, otherOrgId].filter((id): id is string => !!id)
      if (orgs.length) await prisma.organization.deleteMany({ where: { id: { in: orgs } } })
    } finally {
      await new Promise<void>(done => server.close(() => done()))
    }
  })

  it.each([
    '/api/v1/superadmin/venues',
    '/api/v1/superadmin/merchant-accounts',
    '/api/v1/superadmin/billing',
    '/api/v1/superadmin/kyc',
    '/api/v1/dashboard/superadmin/marketing/campaigns',
  ])('GET %s → 403', async path => {
    const res = await request(server).get(path).set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(403)
  })

  it('GET /api/v1/dashboard/venues/<another venue>/payments → 403', async () => {
    const res = await request(server).get(`/api/v1/dashboard/venues/${otherVenueId}/payments`).set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(403)
  })

  it.each(['/mcp', '/mcp/directory'])('POST %s with the seller token serves nothing', async path => {
    const res = await request(server)
      .post(path)
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })

    // A token of the API is not a token of the MCP: its bearer check rejects it before any tool runs. Today that rejection
    // answers 500 instead of 401 (reported apart); what this pins is that nothing is served.
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.body?.result).toBeUndefined()
  })

  it('GET /api/v1/crm/me → 200 with the keys read from the database', async () => {
    const res = await request(server).get('/api/v1/crm/me').set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      data: {
        staffId,
        isSuperadmin: false,
        ver: 'todos',
        editar: 'todos',
        contactar: true,
        campanas: true,
        exportar: true,
        ventas: true,
        admin: true,
        cerrar: true,
        bajas: true,
        plantillas: true,
        preparar: true,
        mandar: true,
        verCampanas: true,
        equipo: true,
        configurar: true,
      },
    })
  })

  // Review I-1: the shared impersonation guard blocks `/api/v1/crm` case-sensitively while Express routes
  // case-insensitively, so the mixed-case URLs reach requireCrm — which must stop them itself. Before the fix they
  // answered 200 with the seller's keys.
  it.each(['/api/v1/crm/me', '/api/v1/Crm/me', '/API/V1/CRM/me'])('an impersonation session gets 403 on %s', async path => {
    const res = await request(server).get(path).set('Authorization', `Bearer ${impersonationToken}`)

    expect(res.status).toBe(403)
    expect(['IMPERSONATION_BLOCKED_ROUTE', 'CRM_FORBIDDEN']).toContain(res.body.code)
  })

  // Last on purpose: it takes the keys away for the rest of the file.
  it('keys removed mid-session: the next request with the SAME token gets 403', async () => {
    await prisma.platformAccess.update({
      where: { email },
      data: { verScope: null, editarScope: null, contactar: false, campanas: false, exportar: false, ventas: false, admin: false },
    })

    const res = await request(server).get('/api/v1/crm/me').set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ code: 'CRM_FORBIDDEN', message: 'No tienes ninguna llave del CRM' })
  })
})
