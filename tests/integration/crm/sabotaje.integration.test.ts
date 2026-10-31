/**
 * Sabotaje del CRM — contra Postgres real, el JWT real y la app entera por supertest (spec 2026-10-30 §5.1, Ruling 3).
 *
 * Un vendedor es VIEWER del venue interno y tiene TODAS las llaves `crm:*`. Esas llaves abren `/api/v1/crm` y nada más:
 * con el mismo token, todo lo del superadmin y lo de un negocio ajeno contesta 403. Con el mock global de Prisma esto no
 * se puede probar — los guardias reales (`authorizeRole`, `checkPermission`) tienen que leer la base de verdad.
 *
 * Run with:
 *   TEST_DATABASE_URL='postgresql://postgres:<contraseña>@localhost:5432/avoqado_crm_test_<fecha>' \
 *     npx jest --selectProjects=integration --runTestsByPath tests/integration/crm/sabotaje.integration.test.ts --ci
 */
import type { Server } from 'http'
import { StaffRole } from '@prisma/client'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'

const sufijo = `crm${Date.now()}`
const correo = `vendedor-${sufijo}@test.mx`

describe('CRM: un vendedor con todas las llaves crm:* sigue siendo VIEWER fuera del CRM', () => {
  let server: Server
  let orgId: string | undefined
  let venueId: string | undefined
  let otraOrgId: string | undefined
  let otroVenueId: string | undefined
  let staffId: string | undefined
  let token: string

  beforeAll(async () => {
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(listo => server.once('listening', () => listo()))

    orgId = (await prisma.organization.create({ data: { name: `Prime ${sufijo}`, email: `prime-${sufijo}@test.mx`, phone: '5555555555' } }))
      .id
    venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `Equipo de ventas ${sufijo}`, slug: `ventas-${sufijo}` } }))
      .id
    otraOrgId = (
      await prisma.organization.create({ data: { name: `Cliente ${sufijo}`, email: `cliente-${sufijo}@test.mx`, phone: '5555555555' } })
    ).id
    otroVenueId = (await prisma.venue.create({ data: { organizationId: otraOrgId, name: `Cliente ${sufijo}`, slug: `cliente-${sufijo}` } }))
      .id

    staffId = (await prisma.staff.create({ data: { email: correo, firstName: 'Vendedor', lastName: 'Sabotaje', emailVerified: true } })).id
    await prisma.staffVenue.create({ data: { staffId, venueId, role: StaffRole.VIEWER, active: true } })
    await prisma.platformAccess.create({
      data: {
        email: correo,
        verScope: 'todos',
        editarScope: 'todos',
        contactar: true,
        campanas: true,
        exportar: true,
        ventas: true,
        admin: true,
        createdById: staffId,
      },
    })

    token = jwt.sign({ sub: staffId, orgId, venueId, role: StaffRole.VIEWER }, process.env.ACCESS_TOKEN_SECRET as string, {
      expiresIn: '15m',
    })
  })

  afterAll(async () => {
    try {
      // Every delete is keyed by an id this file created: a `where` with an undefined value would wipe the whole table.
      await prisma.platformAccess.deleteMany({ where: { email: correo } })
      if (staffId) {
        await prisma.staffVenue.deleteMany({ where: { staffId } })
        await prisma.staff.deleteMany({ where: { id: staffId } })
      }
      const venues = [venueId, otroVenueId].filter((id): id is string => !!id)
      if (venues.length) await prisma.venue.deleteMany({ where: { id: { in: venues } } })
      const orgs = [orgId, otraOrgId].filter((id): id is string => !!id)
      if (orgs.length) await prisma.organization.deleteMany({ where: { id: { in: orgs } } })
    } finally {
      await new Promise<void>(listo => server.close(() => listo()))
    }
  })

  it.each([
    '/api/v1/superadmin/venues',
    '/api/v1/superadmin/merchant-accounts',
    '/api/v1/superadmin/billing',
    '/api/v1/superadmin/kyc',
    '/api/v1/dashboard/superadmin/marketing/campaigns',
  ])('GET %s → 403', async ruta => {
    const res = await request(server).get(ruta).set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(403)
  })

  it('GET /api/v1/dashboard/venues/<otro venue>/payments → 403', async () => {
    const res = await request(server).get(`/api/v1/dashboard/venues/${otroVenueId}/payments`).set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(403)
  })

  it.each(['/mcp', '/mcp/directory'])('POST %s con el token del vendedor no sirve nada', async ruta => {
    const res = await request(server)
      .post(ruta)
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })

    // A token of the API is not a token of the MCP: its bearer check rejects it before any tool runs. Today that rejection
    // answers 500 instead of 401 (reported apart); what this pins is that nothing is served.
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.body?.result).toBeUndefined()
  })

  it('GET /api/v1/crm/me → 200 con sus llaves, leídas de la base', async () => {
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
      },
    })
  })

  // Last on purpose: it takes the keys away for the rest of the file.
  it('quitar las llaves a media sesión: la siguiente petición con el MISMO token da 403', async () => {
    await prisma.platformAccess.update({
      where: { email: correo },
      data: { verScope: null, editarScope: null, contactar: false, campanas: false, exportar: false, ventas: false, admin: false },
    })

    const res = await request(server).get('/api/v1/crm/me').set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ code: 'CRM_FORBIDDEN', message: 'No tienes ninguna llave del CRM' })
  })
})
