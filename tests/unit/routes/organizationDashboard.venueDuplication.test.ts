import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'

import { prismaMock } from '@tests/__helpers__/setup'
import { ForbiddenError, BadRequestError } from '@/errors/AppError'

/**
 * «Duplicar tienda»: rutas HTTP. La autorización es la REAL (`checkOrgAccess` + `requireOrgOwner`); sólo se simulan
 * la autenticación, la capa de datos y el servicio.
 */
const duplicateVenueMock = jest.fn()
const optionsMock = jest.fn()
jest.mock('@/services/organization-dashboard/venueDuplication.service', () => ({
  duplicateVenue: (...a: unknown[]) => duplicateVenueMock(...a),
  getVenueDuplicationOptions: (...a: unknown[]) => optionsMock(...a),
}))
jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: Request, res: Response, next: NextFunction) => {
    const raw = req.headers['x-test-auth-context']
    if (!raw) return res.status(401).json({ message: 'No autorizado' })
    ;(req as any).authContext = JSON.parse(Array.isArray(raw) ? raw[0] : raw)
    next()
  },
}))

import organizationDashboardRoutes from '@/routes/dashboard/organizationDashboard.routes'

const ORG = 'org-a'
const BASE = `/dashboard/organizations/${ORG}/venue-duplication`
const cuid = (c: string) => `c${c.repeat(24)}`
const BODY = {
  idempotencyKey: '3f2b8c1e-5d4a-4f6b-9a7c-1e2d3c4b5a69',
  templateVenueId: cuid('a'),
  name: 'Sucursal Nueva',
  address: { address: 'Calle 1', city: 'CDMX', state: 'CDMX', zipCode: '01000', latitude: 19.4, longitude: -99.1 },
  supervisorStaffId: cuid('b'),
}

const ORGANIZACION: Record<string, { role: string }> = {
  dueno: { role: 'OWNER' },
  'admin-org': { role: 'ADMIN' },
  miembro: { role: 'MEMBER' },
  gerente: { role: 'MEMBER' },
}
const SUCURSAL: Record<string, string> = { 'admin-tienda': 'ADMIN', gerente: 'MANAGER' }

function app() {
  const a = express()
  a.use(express.json())
  a.use('/dashboard/organizations', organizationDashboardRoutes)
  a.use((e: any, _q: Request, res: Response, _n: NextFunction) =>
    res.status(e.statusCode ?? 500).json({ message: e.message, code: e.code }),
  )
  return a
}
const como = (userId: string, role: string, orgId = ORG) => ({ 'x-test-auth-context': JSON.stringify({ userId, orgId, role }) })
const post = (userId: string, role: string, body: unknown = BODY, orgId = ORG) =>
  request(app())
    .post(BASE)
    .set(como(userId, role, orgId))
    .send(body as object)

beforeEach(() => {
  jest.clearAllMocks()
  duplicateVenueMock.mockResolvedValue({ venueId: cuid('c'), slug: 'sucursal-nueva', name: 'Sucursal Nueva' })
  optionsMock.mockResolvedValue({ enabled: true, templates: [], supervisors: [] })
  prismaMock.staff.findUnique.mockResolvedValue({ active: true, firstName: 'A', lastName: 'B' } as any)
  prismaMock.staffOrganization.findFirst.mockImplementation((({ where }: any) => {
    const f = ORGANIZACION[where?.staffId]
    if (!f || where?.organizationId !== ORG) return Promise.resolve(null)
    if (where?.role && f.role !== where.role) return Promise.resolve(null)
    return Promise.resolve({ id: 'so' })
  }) as any)
  prismaMock.staffVenue.findFirst.mockImplementation((({ where }: any) => {
    const r = SUCURSAL[where?.staffId]
    if (!r || (where?.role && where.role !== r)) return Promise.resolve(null)
    return Promise.resolve({ id: 'sv' })
  }) as any)
})

describe('POST venue-duplication', () => {
  it('el dueño de la organización → 201 y el servicio recibe el orgId de la URL y el actor del token', async () => {
    const res = await post('dueno', 'OWNER')
    expect(res.status).toBe(201)
    expect(res.body).toEqual({ success: true, data: { venueId: cuid('c'), slug: 'sucursal-nueva', name: 'Sucursal Nueva' } })
    expect(duplicateVenueMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG, actorStaffId: 'dueno', idempotencyKey: BODY.idempotencyKey }),
    )
  })

  it.each([
    ['ADMIN de la organización', 'admin-org', 'ADMIN'],
    ['ADMIN sólo de tienda (MEMBER en la org)', 'admin-tienda', 'ADMIN'],
    ['MANAGER', 'gerente', 'MANAGER'],
    ['miembro', 'miembro', 'CASHIER'],
  ])('%s → 403 owner_required', async (_n, id, role) => {
    const res = await post(id, role)
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('owner_required')
    expect(duplicateVenueMock).not.toHaveBeenCalled()
  })

  it('un dueño de OTRA organización → 403', async () => {
    const res = await post('dueno', 'OWNER', BODY, 'org-b')
    expect(res.status).toBe(403)
    expect(duplicateVenueMock).not.toHaveBeenCalled()
  })

  it.each([
    ['sin idempotencyKey', { ...BODY, idempotencyKey: undefined }],
    ['idempotencyKey vacía', { ...BODY, idempotencyKey: '' }],
    ['idempotencyKey no uuid', { ...BODY, idempotencyKey: 'abc' }],
    ['sin supervisorStaffId', { ...BODY, supervisorStaffId: undefined }],
    ['name vacío', { ...BODY, name: '' }],
    ['name sólo espacios', { ...BODY, name: '     ' }],
    ['name de 121', { ...BODY, name: 'x'.repeat(121) }],
    ['templateVenueId no cuid', { ...BODY, templateVenueId: 'nope' }],
    ['address con campo extra', { ...BODY, address: { ...BODY.address, planTier: 'ENTERPRISE' } }],
    ['cuerpo con campo extra (orgId)', { ...BODY, orgId: 'org-b' }],
    ['latitude como texto', { ...BODY, address: { ...BODY.address, latitude: '19.4' } }],
  ])('%s → 400', async (_n, body) => {
    const res = await post('dueno', 'OWNER', body)
    expect(res.status).toBe(400)
    expect(duplicateVenueMock).not.toHaveBeenCalled()
  })

  it('recorta el nombre antes de pasarlo al servicio', async () => {
    await post('dueno', 'OWNER', { ...BODY, name: '  Sucursal Nueva  ' })
    expect(duplicateVenueMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'Sucursal Nueva' }))
  })

  it('module_disabled del servicio → 403', async () => {
    duplicateVenueMock.mockRejectedValue(new ForbiddenError('apagado', 'module_disabled'))
    const res = await post('dueno', 'OWNER')
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('module_disabled')
  })

  it('VENUE_NAME_TAKEN del servicio → 400', async () => {
    duplicateVenueMock.mockRejectedValue(new BadRequestError('Ya hay una tienda con ese nombre', 'VENUE_NAME_TAKEN'))
    const res = await post('dueno', 'OWNER')
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('VENUE_NAME_TAKEN')
  })
})

describe('GET venue-duplication/options', () => {
  it('el dueño → 200 con { success, data }', async () => {
    const res = await request(app()).get(`${BASE}/options`).set(como('dueno', 'OWNER'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, data: { enabled: true, templates: [], supervisors: [] } })
    expect(optionsMock).toHaveBeenCalledWith(ORG)
  })
  it('un ADMIN → 403', async () => {
    const res = await request(app()).get(`${BASE}/options`).set(como('admin-org', 'ADMIN'))
    expect(res.status).toBe(403)
  })
})
