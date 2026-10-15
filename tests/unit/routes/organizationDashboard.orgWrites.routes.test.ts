import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'

import { prismaMock } from '@tests/__helpers__/setup'

/**
 * 🔴 Lo que se escribe desde el panel de la organización sin tocar terminales — quién puede.
 *
 * Cinco puertas sólo pedían `checkOrgAccess` (ser MIEMBRO activo de la organización), así que un
 * cajero o un promotor de cualquier sucursal, por la API:
 *   · `PATCH .../time-entries/:timeEntryId/validate`  aprobaba o rechazaba checadas de TODA la org,
 *       las suyas incluidas (asistencia → nómina);
 *   · `PUT   .../goals`                                fijaba las metas de venta de la org;
 *   · `POST/PUT/DELETE .../zones`                     creaba, renombraba o borraba zonas.
 *
 * Ahora las cinco piden el mismo piso que las operaciones de terminal: `requireOrgManager`
 * (supervisor o más; los supervisores de PlayTelecom son MANAGER de sucursal).
 *
 * La autorización es la REAL (`checkOrgAccess`, `requireOrgManager`); sólo se simulan la
 * autenticación, la capa de datos y el servicio que escribe.
 */

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: Request, res: Response, next: NextFunction) => {
    const raw = req.headers['x-test-auth-context']
    const value = Array.isArray(raw) ? raw[0] : raw
    if (!value) {
      res.status(401).json({ message: 'No autorizado' })
      return
    }
    ;(req as any).authContext = JSON.parse(value)
    next()
  },
}))

import organizationDashboardRoutes from '@/routes/dashboard/organizationDashboard.routes'
import { organizationDashboardService } from '@/services/organization-dashboard/organizationDashboard.service'

const ORG = 'org-a'
const VENUE_A = 'venue-a'
const ZONA = 'zona-norte'
const CHECADA = 'te-1'

/** Filas `StaffVenue`. */
const SUCURSAL: Array<{ staffId: string; venueId: string; organizationId: string; role: string }> = [
  { staffId: 'cajero', venueId: VENUE_A, organizationId: ORG, role: 'CASHIER' },
  { staffId: 'promotor', venueId: VENUE_A, organizationId: ORG, role: 'WAITER' }, // los promotores de PlayTelecom son WAITER
  { staffId: 'gerente', venueId: VENUE_A, organizationId: ORG, role: 'MANAGER' }, // el supervisor de PlayTelecom
  { staffId: 'super-1', venueId: 'venue-plataforma', organizationId: 'org-plataforma', role: 'SUPERADMIN' },
]
/** Filas `StaffOrganization`. */
const ORGANIZACION: Array<{ staffId: string; organizationId: string; role: string; isActive: boolean }> = [
  { staffId: 'cajero', organizationId: ORG, role: 'MEMBER', isActive: true },
  { staffId: 'promotor', organizationId: ORG, role: 'MEMBER', isActive: true },
  { staffId: 'miembro-org', organizationId: ORG, role: 'MEMBER', isActive: true }, // sólo fila de la org, sin sucursal
  { staffId: 'dueno-org', organizationId: ORG, role: 'OWNER', isActive: true },
]

function coincideRol(filtro: unknown, rol: string): boolean {
  if (filtro === undefined) return true
  if (typeof filtro === 'string') return filtro === rol
  return ((filtro as { in?: string[] }).in ?? []).includes(rol)
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/dashboard/organizations', organizationDashboardRoutes)
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.statusCode ?? 500).json({ message: error.message, code: error.code })
  })
  return app
}

function como(userId: string, tokenRole: string) {
  const venueId = SUCURSAL.find(f => f.staffId === userId)?.venueId ?? VENUE_A
  return { 'x-test-auth-context': JSON.stringify({ userId, orgId: ORG, venueId, role: tokenRole }) }
}

const BASE = `/dashboard/organizations/${ORG}`

let validateTimeEntry: jest.SpyInstance
let updateOrganizationGoal: jest.SpyInstance
let createZone: jest.SpyInstance
let updateZone: jest.SpyInstance
let deleteZone: jest.SpyInstance

/** Cada puerta: cómo se pide, qué servicio escribe, con qué argumentos y qué estado devuelve si pasa. */
const PUERTAS: Array<[string, (u: string, r: string) => request.Test, () => jest.SpyInstance, (u: string) => unknown[], number]> = [
  [
    'PATCH .../time-entries/:timeEntryId/validate (aprobar)',
    (u, r) => request(makeApp()).patch(`${BASE}/time-entries/${CHECADA}/validate`).set(como(u, r)).send({ status: 'APPROVED' }),
    () => validateTimeEntry,
    u => [CHECADA, ORG, u, 'APPROVED', undefined],
    200,
  ],
  [
    'PATCH .../time-entries/:timeEntryId/validate (rechazar)',
    (u, r) =>
      request(makeApp()).patch(`${BASE}/time-entries/${CHECADA}/validate`).set(como(u, r)).send({ status: 'REJECTED', note: 'No vino' }),
    () => validateTimeEntry,
    u => [CHECADA, ORG, u, 'REJECTED', 'No vino'],
    200,
  ],
  [
    'PUT .../goals',
    (u, r) =>
      request(makeApp())
        .put(`${BASE}/goals`)
        .set(como(u, r))
        .send({ period: 'monthly', periodDate: '2026-10-01T00:00:00.000Z', salesTarget: 100000, volumeTarget: 500 }),
    () => updateOrganizationGoal,
    u => [ORG, 'monthly', new Date('2026-10-01T00:00:00.000Z'), 100000, 500, u],
    200,
  ],
  [
    'POST .../zones',
    (u, r) => request(makeApp()).post(`${BASE}/zones`).set(como(u, r)).send({ name: 'Norte', slug: 'norte' }),
    () => createZone,
    u => [ORG, 'Norte', 'norte', u],
    201,
  ],
  [
    'PUT .../zones/:zoneId',
    (u, r) => request(makeApp()).put(`${BASE}/zones/${ZONA}`).set(como(u, r)).send({ name: 'Norte 2' }),
    () => updateZone,
    u => [ORG, ZONA, { name: 'Norte 2', slug: undefined }, u],
    200,
  ],
  [
    'DELETE .../zones/:zoneId',
    (u, r) => request(makeApp()).delete(`${BASE}/zones/${ZONA}`).set(como(u, r)),
    () => deleteZone,
    u => [ORG, ZONA, u],
    200,
  ],
]

beforeEach(() => {
  jest.clearAllMocks()
  validateTimeEntry = jest.spyOn(organizationDashboardService, 'validateTimeEntry').mockResolvedValue({ id: CHECADA } as any)
  updateOrganizationGoal = jest.spyOn(organizationDashboardService, 'updateOrganizationGoal').mockResolvedValue({ id: 'goal-1' } as any)
  createZone = jest.spyOn(organizationDashboardService, 'createZone').mockResolvedValue({ id: ZONA } as any)
  updateZone = jest.spyOn(organizationDashboardService, 'updateZone').mockResolvedValue({ id: ZONA } as any)
  deleteZone = jest.spyOn(organizationDashboardService, 'deleteZone').mockResolvedValue({ id: ZONA } as any)

  prismaMock.staff.findUnique.mockResolvedValue({ active: true, firstName: 'Ana', lastName: 'Prueba' } as any)

  // checkOrgAccess / requireOrgManager / superadmin real
  prismaMock.staffVenue.findFirst.mockImplementation((({ where }: any) => {
    const fila = SUCURSAL.find(
      f =>
        f.staffId === where?.staffId &&
        coincideRol(where?.role, f.role) &&
        (!where?.venue?.organizationId || where.venue.organizationId === f.organizationId),
    )
    return Promise.resolve(fila ? { id: `sv-${fila.staffId}` } : null)
  }) as any)
  prismaMock.staffOrganization.findFirst.mockImplementation((({ where }: any) => {
    const fila = ORGANIZACION.find(
      f =>
        f.staffId === where?.staffId &&
        f.organizationId === where?.organizationId &&
        (where?.isActive !== true || f.isActive) &&
        coincideRol(where?.role, f.role),
    )
    return Promise.resolve(fila ? { id: `so-${fila.staffId}` } : null)
  }) as any)
})

afterEach(() => {
  for (const espia of [validateTimeEntry, updateOrganizationGoal, createZone, updateZone, deleteZone]) espia.mockRestore()
})

describe.each(PUERTAS)('%s', (_label, pedir, servicio, argumentos, estadoSiPasa) => {
  it.each([
    ['un cajero', 'cajero', 'CASHIER'],
    ['un promotor', 'promotor', 'WAITER'],
    ['un miembro de la org sin sucursal', 'miembro-org', 'VIEWER'],
  ])('🔴 %s → 403 en español y nada escrito', async (_l, userId, rol) => {
    const res = await pedir(userId, rol)

    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ success: false, error: 'insufficient_role', message: 'Se requiere rol de supervisor o superior' })
    expect(servicio()).not.toHaveBeenCalled()
  })

  it.each([
    ['el gerente de la sucursal (supervisor)', 'gerente', 'MANAGER'],
    ['el dueño de la organización', 'dueno-org', 'OWNER'],
    ['el superadmin de verdad', 'super-1', 'SUPERADMIN'],
  ])('%s sí puede', async (_l, userId, rol) => {
    const res = await pedir(userId, rol)

    expect(res.status).toBe(estadoSiPasa)
    expect(servicio()).toHaveBeenCalledWith(...argumentos(userId))
  })
})
