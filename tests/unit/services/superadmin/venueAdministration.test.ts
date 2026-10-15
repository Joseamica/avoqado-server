import express from 'express'
import request from 'supertest'
import { Prisma, StaffRole } from '@prisma/client'

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (req.headers['x-test-role']) req.authContext = { userId: 'cactor00000000000000000000', role: req.headers['x-test-role'] } as never
    next()
  },
}))
jest.mock('@/services/access/rolVigente', () => ({ rolVigente: jest.fn() }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  socketManager: { broadcastToRole: jest.fn(), getServer: jest.fn() },
}))

import superadminRouter from '@/routes/superadmin.routes'
import { rolVigente } from '@/services/access/rolVigente'
import { logAction } from '@/services/dashboard/activity-log.service'
import { socketManager } from '@/communication/sockets/managers/socketManager'
import { prismaMock } from '@tests/__helpers__/setup'
import { updateVenueProfile } from '@/services/superadmin/venueAdministration.service'

const app = express()
app.use(express.json())
app.use('/api/v1/superadmin', superadminRouter)
app.use((error: { statusCode?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(error.statusCode ?? 500).json({ message: error.message })
})

const venueId = 'cvenue00000000000000000000'
const orgId = 'corgan00000000000000000000'
const ownerId = 'cowner00000000000000000000'
const originalTime = '2026-10-15T12:00:00.000Z'
const path = `/api/v1/superadmin/venues/${venueId}/administration`
let venue: Record<string, any>
let organization: Record<string, any>
let owner: Record<string, any>
let membership: Record<string, any>
let inTransaction = false

// Simulate Prisma's explicit projection: returning all mock fields would conceal accidental includes.
function project(value: Record<string, any>, select?: Record<string, any>): any {
  if (!select) return value
  return Object.fromEntries(
    Object.entries(select).map(([key, rule]) => [key, rule === true ? value[key] : project(value[key], rule.select)]),
  )
}

beforeEach(() => {
  jest.mocked(rolVigente).mockResolvedValue(StaffRole.SUPERADMIN)
  inTransaction = false
  venue = {
    id: venueId,
    organizationId: orgId,
    name: 'Tienda Norte',
    slug: 'tienda-norte',
    type: 'RETAIL_STORE',
    operationalRole: 'STORE',
    address: 'Calle Norte 20',
    city: 'Ciudad de México',
    state: 'CDMX',
    country: 'MX',
    zipCode: '01234',
    phone: '5512345678',
    email: 'contacto@example.com',
    website: null,
    latitude: new Prisma.Decimal('19.4326'),
    longitude: new Prisma.Decimal('-99.1332'),
    language: 'es',
    timezone: 'America/Mexico_City',
    currency: 'MXN',
    entityType: null,
    rfc: null,
    legalName: null,
    fiscalRegime: null,
    status: 'ACTIVE',
    kycStatus: 'NOT_SUBMITTED',
    suspensionReason: null,
    updatedAt: new Date(originalTime),
    active: true,
    idDocumentUrl: 'private-secret-url',
    facturapiApiKey: 'secret-key',
  }
  organization = {
    id: orgId,
    name: 'Grupo Norte',
    email: 'grupo@example.com',
    phone: '5512345678',
    taxId: null,
    billingEmail: null,
    updatedAt: new Date(originalTime),
    _count: { venues: 17 },
  }
  owner = {
    id: ownerId,
    firstName: 'Ana',
    lastName: 'Norte',
    email: 'ana@example.com',
    phone: '5512345678',
    updatedAt: new Date(originalTime),
    active: true,
    password: 'secret-password',
  }
  membership = { id: 'cmember0000000000000000000', role: 'OWNER', staffId: ownerId, staff: owner, active: true }
  prismaMock.$transaction.mockImplementation(async (callback: any) => {
    inTransaction = true
    try {
      return await callback(prismaMock)
    } finally {
      inTransaction = false
    }
  })
  prismaMock.$queryRaw.mockResolvedValue([{ id: venueId }])
  prismaMock.venue.findUnique.mockImplementation(async ({ select }: any) => project(venue, select))
  prismaMock.organization.findUnique.mockImplementation(async ({ select }: any) => project(organization, select))
  prismaMock.staffVenue.findFirst.mockImplementation(async ({ where, select }: any) => {
    if (where.role && where.role !== membership?.role) return null
    return membership ? project({ ...membership, staff: owner }, select) : null
  })
  prismaMock.staffVenue.count.mockResolvedValue(8)
  prismaMock.venue.count.mockResolvedValue(17)
  prismaMock.venue.updateMany.mockImplementation(async ({ data }: any) => {
    Object.assign(venue, data)
    return { count: 1 }
  })
  prismaMock.organization.updateMany.mockImplementation(async ({ data }: any) => {
    Object.assign(organization, data)
    return { count: 1 }
  })
  prismaMock.staff.updateMany.mockImplementation(async ({ data }: any) => {
    Object.assign(owner, data)
    return { count: 1 }
  })
  jest.mocked(logAction).mockImplementation(async () => {
    expect(inTransaction).toBe(false)
  })
})

const patch = (section: string, body: Record<string, unknown>) =>
  request(app).patch(`/api/v1/superadmin/venues/${venueId}/${section}`).set('x-test-role', 'SUPERADMIN').send(body)
const profile = (changes: Record<string, unknown>, expectedUpdatedAt = originalTime) => patch('profile', { expectedUpdatedAt, changes })

describe('venue administration — HTTP, validation and authorization', () => {
  it('returns only administrative fields, ISO revisions, numeric coordinates and exact shared counts', async () => {
    const { body } = await request(app).get(path).set('x-test-role', 'SUPERADMIN').expect(200)
    expect(body.data.venue).toMatchObject({ id: venueId, latitude: 19.4326, longitude: -99.1332, updatedAt: originalTime })
    expect(body.data.organization).toMatchObject({ id: orgId, venueCount: 17 })
    expect(body.data.owner).toMatchObject({ id: ownerId, role: 'OWNER', venueCount: 8, updatedAt: originalTime })
    expect(body.data.allowedStatusTransitions).toEqual(['SUSPENDED', 'ADMIN_SUSPENDED', 'CLOSED'])
    expect(JSON.stringify(body)).not.toMatch(/secret|password|idDocumentUrl|facturapiApiKey/)
    expect(prismaMock.staffVenue.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ venueId, active: true, role: 'OWNER', staff: { active: true } }),
        orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
      }),
    )
  })

  it('falls back to active ADMIN and returns null when no active contact exists', async () => {
    membership.role = 'ADMIN'
    const admin = await request(app).get(path).set('x-test-role', 'SUPERADMIN').expect(200)
    expect(admin.body.data.owner.role).toBe('ADMIN')
    membership = null as any
    const missing = await request(app).get(path).set('x-test-role', 'SUPERADMIN').expect(200)
    expect(missing.body.data.owner).toBeNull()
  })

  it('requires authentication', async () => {
    await request(app).get(path).expect(401)
  })

  it.each(['OWNER', 'ADMIN', 'VIEWER'])('denies the current %s role even with an old SUPERADMIN token', async role => {
    jest.mocked(rolVigente).mockResolvedValue(role as StaffRole)
    await profile({ name: 'Otro nombre' }).expect(403)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it.each([
    {},
    { currency: 'USD' },
    { timezone: 'UTC' },
    { organizationId: orgId },
    { operationalRole: 'CEDIS' },
    { salesEnabled: false },
    { kycStatus: 'VERIFIED' },
    { status: 'ACTIVE' },
    { type: 'INVALID' },
    { language: 'fr' },
    { latitude: 91 },
    { longitude: -181 },
    { slug: 'Invalid Slug' },
    { email: 'invalid' },
    { website: 'invalid' },
    { rfc: 'not-an-rfc' },
  ])('rejects empty, malformed and non-allowlisted profile data %j', async changes => {
    await profile(changes).expect(400)
    expect(prismaMock.venue.updateMany).not.toHaveBeenCalled()
  })

  it('rejects unknown envelope fields and invalid revisions', async () => {
    await patch('profile', { expectedUpdatedAt: originalTime, changes: { name: 'Nuevo' }, force: true }).expect(400)
    await profile({ name: 'Nuevo' }, 'yesterday').expect(400)
  })

  it('clears optional fields with null or whitespace while preserving omitted values', async () => {
    const { body } = await profile({ phone: null, email: '  ', latitude: null, legalName: null }).expect(200)
    expect(body.data.venue).toMatchObject({ phone: null, email: null, latitude: null, address: 'Calle Norte 20' })
    expect(prismaMock.venue.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: venueId, updatedAt: new Date(originalTime) }),
        data: expect.objectContaining({ phone: null, email: null, latitude: null }),
      }),
    )
    expect(prismaMock.venue.updateMany.mock.calls[0][0].data).not.toHaveProperty('address')
  })

  it('reports missing venues with 404', async () => {
    prismaMock.venue.findUnique.mockResolvedValue(null)
    await request(app).get(path).set('x-test-role', 'SUPERADMIN').expect(404)
  })

  it('accepts legacy UUID identities without generating or rewriting any id', async () => {
    const legacyId = '760cd1c7-08cb-4d61-bdd8-fda523ce1185'
    venue.id = legacyId
    const { body } = await request(app)
      .get(`/api/v1/superadmin/venues/${legacyId}/administration`)
      .set('x-test-role', 'SUPERADMIN')
      .expect(200)
    expect(body.data.venue.id).toBe(legacyId)
  })

  it.each(['javascript:alert(1)', 'ftp://example.com'])('rejects a non-web clickable URL %s', async website => {
    await profile({ website }).expect(400)
    expect(prismaMock.venue.updateMany).not.toHaveBeenCalled()
  })
})

describe('venue administration — CAS, shared identity and audit', () => {
  it('rejects a stale revision without writing or auditing', async () => {
    await profile({ name: 'Nuevo' }, '2026-10-14T12:00:00.000Z').expect(409)
    expect(prismaMock.venue.updateMany).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('enforces CAS in the actual UPDATE when another writer wins after reading', async () => {
    prismaMock.venue.updateMany.mockResolvedValue({ count: 0 })
    await profile({ name: 'Nuevo' }).expect(409)
    expect(logAction).not.toHaveBeenCalled()
  })

  it('maps a database serialization race to an actionable conflict', async () => {
    prismaMock.$transaction.mockRejectedValue({ code: 'P2034' })
    const result = await profile({ name: 'Nuevo' }).expect(409)
    expect(result.body.message).toContain('Actualiza')
    expect(logAction).not.toHaveBeenCalled()
  })

  it.each(['40001', '40P01'])('maps the raw SQL concurrency error %s to an actionable conflict', async sqlState => {
    prismaMock.$transaction.mockRejectedValue({ code: 'P2010', meta: { code: sqlState } })
    const result = await profile({ name: 'Nuevo' }).expect(409)
    expect(result.body.message).toContain('Actualiza')
    expect(logAction).not.toHaveBeenCalled()
  })

  it.each(['23505', '42601', '40001-other', undefined])('preserves unrelated raw SQL errors %s unchanged', async sqlState => {
    const original = { code: 'P2010', meta: { code: sqlState }, message: 'Error original de SQL' }
    prismaMock.$transaction.mockRejectedValue(original)
    await expect(updateVenueProfile(venueId, { expectedUpdatedAt: originalTime, changes: { name: 'Nuevo' } }, 'actor')).rejects.toBe(
      original,
    )
    expect(logAction).not.toHaveBeenCalled()
  })

  it('maps a concurrent unique slug violation to 409', async () => {
    prismaMock.venue.updateMany.mockRejectedValue({ code: 'P2002', meta: { target: ['slug'] } })
    await patch('profile', { expectedUpdatedAt: originalTime, confirmSlugChange: true, changes: { slug: 'occupied' } }).expect(409)
  })

  it('requires explicit acknowledgement before invalidating existing public links', async () => {
    const result = await profile({ slug: 'otra-tienda' }).expect(400)
    expect(result.body.message).toContain('enlaces anteriores')
    expect(prismaMock.venue.updateMany).not.toHaveBeenCalled()
    await patch('profile', { expectedUpdatedAt: originalTime, confirmSlugChange: true, changes: { slug: 'otra-tienda' } }).expect(200)
    expect(venue.slug).toBe('otra-tienda')
  })

  it('keeps a CEDIS type OTHER without changing operational configuration', async () => {
    venue.operationalRole = 'CEDIS'
    venue.type = 'OTHER'
    await profile({ type: 'RETAIL_STORE' }).expect(400)
    expect(prismaMock.venue.updateMany).not.toHaveBeenCalled()
  })

  it('requires explicit shared confirmation and the expected organization identity', async () => {
    await patch('organization', { expectedUpdatedAt: originalTime, changes: { name: 'Nuevo grupo' } }).expect(400)
    await patch('organization', {
      expectedUpdatedAt: originalTime,
      expectedOrganizationId: orgId,
      confirmShared: false,
      changes: { name: 'Nuevo grupo' },
    }).expect(400)
    await patch('organization', {
      expectedUpdatedAt: originalTime,
      expectedOrganizationId: 'cother00000000000000000000',
      confirmShared: true,
      changes: { name: 'Nuevo grupo' },
    }).expect(409)
    expect(prismaMock.organization.updateMany).not.toHaveBeenCalled()
  })

  it('updates only the current linked organization using CAS and reports its shared scope', async () => {
    const result = await patch('organization', {
      expectedUpdatedAt: originalTime,
      expectedOrganizationId: orgId,
      confirmShared: true,
      changes: { billingEmail: null, name: 'Grupo Nuevo' },
    }).expect(200)
    expect(result.body.data.organization).toMatchObject({ name: 'Grupo Nuevo', billingEmail: null, venueCount: 17 })
    expect(prismaMock.organization.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: orgId, updatedAt: new Date(originalTime), venues: { some: { id: venueId } } }),
      }),
    )
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: 'cactor00000000000000000000',
        venueId,
        organizationId: orgId,
        entity: 'Organization',
        data: expect.objectContaining({ changes: { name: { from: 'Grupo Norte', to: 'Grupo Nuevo' } }, venueCount: 17 }),
      }),
    )
  })

  it('checks the current owner identity inside the transaction and forbids changing access email', async () => {
    await patch('owner', {
      expectedUpdatedAt: originalTime,
      expectedOwnerId: 'cother00000000000000000000',
      confirmShared: true,
      changes: { firstName: 'Otra' },
    }).expect(409)
    await patch('owner', {
      expectedUpdatedAt: originalTime,
      expectedOwnerId: ownerId,
      confirmShared: true,
      changes: { email: 'other@example.com' },
    }).expect(400)
    expect(prismaMock.staff.updateMany).not.toHaveBeenCalled()
  })

  it('updates the selected active contact with staff revision and membership predicate', async () => {
    const result = await patch('owner', {
      expectedUpdatedAt: originalTime,
      expectedOwnerId: ownerId,
      confirmShared: true,
      changes: { phone: null },
    }).expect(200)
    expect(result.body.data.owner.phone).toBeNull()
    expect(prismaMock.staff.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: ownerId,
          updatedAt: new Date(originalTime),
          active: true,
          venues: { some: { id: membership.id, venueId, role: 'OWNER', active: true } },
        }),
      }),
    )
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'Staff', entityId: ownerId, data: expect.objectContaining({ venueCount: 8 }) }),
    )
  })

  it('does not audit or broadcast a no-op', async () => {
    await profile({ name: 'Tienda Norte' }).expect(200)
    expect(prismaMock.venue.updateMany).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
    expect(socketManager.broadcastToRole).not.toHaveBeenCalled()
  })

  it('audits only the sanitized delta after commit and emits the existing superadmin convention', async () => {
    await profile({ name: 'Tienda Sur' }).expect(200)
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SUPERADMIN_VENUE_PROFILE_UPDATED',
        entity: 'Venue',
        entityId: venueId,
        staffId: 'cactor00000000000000000000',
        venueId,
        data: { changes: { name: { from: 'Tienda Norte', to: 'Tienda Sur' } } },
      }),
    )
    expect(socketManager.broadcastToRole).toHaveBeenCalledWith('SUPERADMIN', 'superadmin:venue:updated', { id: venueId })
  })
})

describe('venue administration — state regression', () => {
  it.each(['SUSPENDED', 'ADMIN_SUSPENDED', 'CLOSED'])('requires a reason for %s', async status => {
    await patch('status', { expectedUpdatedAt: originalTime, status }).expect(400)
    await patch('status', { expectedUpdatedAt: originalTime, status, reason: '  ' }).expect(400)
    expect(prismaMock.venue.updateMany).not.toHaveBeenCalled()
  })

  it('only permits existing state transitions', async () => {
    await patch('status', { expectedUpdatedAt: originalTime, status: 'TRIAL' }).expect(400)
    expect(prismaMock.venue.updateMany).not.toHaveBeenCalled()
  })

  it.each(['SUSPENDED', 'ADMIN_SUSPENDED', 'CLOSED'])('preserves the legacy inactive side effect for %s', async status => {
    const { body } = await patch('status', { expectedUpdatedAt: originalTime, status, reason: 'Petición documentada' }).expect(200)
    expect(body.data.venue).toMatchObject({ status, suspensionReason: 'Petición documentada', kycStatus: 'NOT_SUBMITTED' })
    expect(prismaMock.venue.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'ACTIVE', updatedAt: new Date(originalTime) }),
        data: expect.objectContaining({ active: false, statusChangedBy: 'cactor00000000000000000000' }),
      }),
    )
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SUPERADMIN_VENUE_STATUS_UPDATED',
        data: expect.objectContaining({ changes: expect.objectContaining({ status: { from: 'ACTIVE', to: status } }) }),
      }),
    )
  })

  it('reactivates and clears the reason without approving KYC or changing the plan', async () => {
    venue.status = 'ADMIN_SUSPENDED'
    venue.suspensionReason = 'Motivo previo'
    venue.active = false
    const { body } = await patch('status', { expectedUpdatedAt: originalTime, status: 'ACTIVE' }).expect(200)
    expect(body.data.venue).toMatchObject({ status: 'ACTIVE', suspensionReason: null, kycStatus: 'NOT_SUBMITTED' })
    const update = prismaMock.venue.updateMany.mock.calls[0][0].data
    expect(update.active).toBe(true)
    expect(update).not.toHaveProperty('kycStatus')
    expect(update).not.toHaveProperty('planTier')
  })
})
