import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'

import { prismaMock } from '@tests/__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'

/**
 * 🔴 Ronda 3 (Codex, 17-oct): `PUT /api/v1/organizations/:orgId` era la puerta lateral.
 *
 * `checkOwnerAccess` acepta ser OWNER de CUALQUIER sucursal de la org, y el servicio le pasaba el cuerpo a
 * `prisma.organization.update` casi entero (sólo `sinCamposReservados` quitaba pago al personal y exención de plan). Con
 * `{"attendanceConfig":{"update":{…}}}` o `{"attendanceConfig":{"delete":true}}` el dueño de UNA tienda cambiaba o borraba
 * la config de checador y TPV de TODA la org — lo que las seis escrituras cerradas en las rondas 1-2 ya no le dejan — y
 * con otras relaciones de Organization, cualquier cosa.
 *
 * Ahora: (a) sólo los campos escalares que el dashboard manda, con Zod `.strict()` (cero escrituras anidadas); (b) sólo
 * el dueño de la org o un superadmin de verdad; (c) el asiento con autor, org y sólo lo que cambió.
 */

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: Request, _res: Response, next: NextFunction) => {
    ;(req as any).authContext = JSON.parse(String(req.headers['x-test-auth-context']))
    next()
  },
}))

import organizationRoutes from '@/routes/organization.routes'

const ORG = 'org-a'
const VENUE_DE: Record<string, string> = { 'venue-a': ORG, 'venue-otra': 'org-otra', 'venue-plataforma': 'org-plataforma' }
const DADOS_DE_BAJA = new Set(['dueno-org-baja'])
const SUCURSAL = [
  { staffId: 'dueno-suc', venueId: 'venue-a', role: 'OWNER', active: true }, // dueño de UNA tienda, MEMBER de la org
  { staffId: 'super-1', venueId: 'venue-plataforma', role: 'SUPERADMIN', active: true },
]
const ORGANIZACION = [
  { staffId: 'dueno-suc', organizationId: ORG, role: 'MEMBER', isActive: true },
  { staffId: 'dueno-org', organizationId: ORG, role: 'OWNER', isActive: true }, // sin fila de tienda
  { staffId: 'ex-dueno-org', organizationId: ORG, role: 'OWNER', isActive: false },
  { staffId: 'dueno-org-baja', organizationId: ORG, role: 'OWNER', isActive: true }, // persona dada de baja
]
const ROL: Record<string, string> = {
  'dueno-suc': 'OWNER',
  'dueno-org': 'OWNER',
  'ex-dueno-org': 'OWNER',
  'dueno-org-baja': 'OWNER',
  'super-1': 'SUPERADMIN',
}

const coincide = (filtro: unknown, valor: string) =>
  filtro === undefined || (typeof filtro === 'string' ? filtro === valor : ((filtro as { in?: string[] }).in ?? []).includes(valor))

const ANTES = { id: ORG, name: 'Org A', email: 'a@orga.mx', phone: '555', taxId: null, billingEmail: null, billingAddress: null }

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/organizations', organizationRoutes)
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.statusCode ?? 500).json({ message: error.message, code: error.code, details: error.details })
  })
  return app
}
const editar = (actor: string, cuerpo: unknown) =>
  request(makeApp())
    .put(`/api/v1/organizations/${ORG}`)
    .set({ 'x-test-auth-context': JSON.stringify({ userId: actor, orgId: ORG, venueId: 'venue-a', role: ROL[actor] }) })
    .send(cuerpo as object)

const bitacora = (action: string) => (logAction as jest.Mock).mock.calls.map(([p]) => p).filter(p => p?.action === action)

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.staffVenue.findFirst.mockImplementation((({ where }: any) => {
    const fila = SUCURSAL.find(
      f =>
        f.staffId === where?.staffId &&
        coincide(where?.role, f.role) &&
        (where?.active !== true || f.active) &&
        (where?.staff?.active !== true || !DADOS_DE_BAJA.has(f.staffId)) &&
        (!where?.venue?.organizationId || VENUE_DE[f.venueId] === where.venue.organizationId),
    )
    return Promise.resolve(fila ? { id: `sv-${fila.staffId}` } : null)
  }) as any)
  prismaMock.staffOrganization.findFirst.mockImplementation((({ where }: any) => {
    const fila = ORGANIZACION.find(
      f =>
        f.staffId === where?.staffId &&
        f.organizationId === where?.organizationId &&
        coincide(where?.role, f.role) &&
        (where?.isActive !== true || f.isActive) &&
        (where?.staff?.active !== true || !DADOS_DE_BAJA.has(f.staffId)),
    )
    return Promise.resolve(fila ? { id: `so-${fila.staffId}` } : null)
  }) as any)
  prismaMock.organization.findUnique.mockImplementation((({ where }: any) =>
    Promise.resolve(where?.id === ORG ? { ...ANTES } : null)) as any)
  prismaMock.organization.update.mockImplementation((({ data }: any) => Promise.resolve({ ...ANTES, ...data })) as any)
})

const CUERPOS_DE_CODEX = [
  [
    'cambiar la config de checador/TPV de la org',
    { attendanceConfig: { update: { attendanceTracking: false, enableCardPayments: false } } },
  ],
  ['borrarla', { attendanceConfig: { delete: true } }],
] as const

describe('PUT /organizations/:orgId — lista blanca y sólo el dueño de la org', () => {
  it.each(CUERPOS_DE_CODEX)('🔴 el dueño de la org que intenta %s por aquí → 400 y Prisma nunca se toca', async (_l, cuerpo) => {
    const res = await editar('dueno-org', cuerpo)

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('CAMPOS_NO_EDITABLES')
    expect(res.body.message).toContain('attendanceConfig')
    expect(prismaMock.organization.update).not.toHaveBeenCalled()
    expect(prismaMock.organization.findUnique).not.toHaveBeenCalled()
  })

  it.each(CUERPOS_DE_CODEX)('🔴 el dueño de UNA tienda que intenta %s → 403 y Prisma nunca se toca', async (_l, cuerpo) => {
    const res = await editar('dueno-suc', cuerpo)

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('ORG_OWNER_REQUIRED')
    expect(prismaMock.organization.update).not.toHaveBeenCalled()
  })

  it.each([
    ['otra relación de Organization', { venues: { deleteMany: {} } }],
    ['un escalar que no se edita aquí', { name: 'Org A', slug: 'otra-org' }],
    ['una operación de Prisma en vez de un valor', { name: { set: 'Org B' } }],
  ])('🔴 %s → 400 y nada escrito', async (_l, cuerpo) => {
    const res = await editar('dueno-org', cuerpo)

    expect(res.status).toBe(400)
    expect(prismaMock.organization.update).not.toHaveBeenCalled()
  })

  it('el dueño de la org guarda los campos de siempre, y sólo esos llegan a Prisma', async () => {
    const cuerpo = { name: 'Org A Nueva', email: 'a@orga.mx', phone: '555', taxId: null, billingEmail: null }
    const res = await editar('dueno-org', cuerpo)

    expect(res.status).toBe(200)
    expect(prismaMock.organization.update).toHaveBeenCalledWith({ where: { id: ORG }, data: cuerpo })
  })

  it('el superadmin de verdad también', async () => {
    const res = await editar('super-1', { phone: '556' })

    expect(res.status).toBe(200)
    expect(prismaMock.organization.update).toHaveBeenCalledWith({ where: { id: ORG }, data: { phone: '556' } })
  })

  it.each([
    ['🔴 el dueño de UNA tienda (no de la org)', 'dueno-suc'],
    ['🔴 quien fue dueño de la org (fila apagada)', 'ex-dueno-org'],
    ['🔴 el dueño de la org dado de baja', 'dueno-org-baja'],
  ])('%s → 403 en español con código, nada escrito y la negativa en la bitácora', async (_l, actor) => {
    const res = await editar(actor, { name: 'Org A Nueva' })

    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({
      message: 'Sólo el dueño de la organización puede cambiar los datos de la organización. Pídeselo al dueño.',
      code: 'ORG_OWNER_REQUIRED',
    })
    expect(prismaMock.organization.update).not.toHaveBeenCalled()
    expect(bitacora('PERMISSION_DENIED')).toEqual([
      expect.objectContaining({ staffId: actor, organizationId: ORG, entityId: 'ORGANIZATION_DETAILS' }),
    ])
  })

  it('regresión: pago al personal y la exención de plan siguen respondiendo CAMPOS_RESERVADOS', async () => {
    const res = await editar('dueno-org', { staffPayStartDate: null })

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('CAMPOS_RESERVADOS')
    expect(prismaMock.organization.update).not.toHaveBeenCalled()
  })

  it('el asiento lleva autor, la org en su columna y sólo lo que cambió (de → a)', async () => {
    await editar('dueno-org', { name: 'Org A Nueva', email: 'a@orga.mx', phone: '555' })

    expect(bitacora('ORGANIZATION_UPDATED')).toEqual([
      {
        staffId: 'dueno-org',
        organizationId: ORG,
        action: 'ORGANIZATION_UPDATED',
        entity: 'Organization',
        entityId: ORG,
        data: { changes: { name: { from: 'Org A', to: 'Org A Nueva' } } },
      },
    ])
  })
})
