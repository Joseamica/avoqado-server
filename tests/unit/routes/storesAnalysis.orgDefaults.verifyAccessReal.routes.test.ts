import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'

import { prismaMock } from '@tests/__helpers__/setup'

/**
 * 🔴 La regla «sólo el dueño de la organización» en la puerta de la SUCURSAL, con el `verifyAccess` REAL.
 *
 * `storesAnalysis.writes.routes.test.ts` simula `verifyAccess` (le pone a `req.access` el rol del token). Aquí corre el
 * de verdad (`getUserAccess` completo: superadmin, fila de la sucursal, módulo white-label con herencia de la org,
 * dueños de org), y cada doble de Prisma contesta según su `where`. Lo que demuestra: el OWNER de UNA tienda pasa el
 * acceso a la sucursal y `requireOwnerPlus`, llega hasta la regla nueva y AHÍ recibe el 403 (el mensaje es el suyo,
 * no el de los guardias de antes); el dueño de la org, sin fila en la tienda, pasa.
 */

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: Request, _res: Response, next: NextFunction) => {
    ;(req as any).authContext = JSON.parse(String(req.headers['x-test-auth-context']))
    next()
  },
}))

import storesAnalysisRouter from '@/routes/dashboard/storesAnalysis.routes'
import { organizationDashboardService } from '@/services/organization-dashboard/organizationDashboard.service'

const ORG = 'org-pt'
const OTRA_ORG = 'org-otra'
const VA = 'venue-a'
const VO = 'venue-otra' // tienda de OTRA organización
const ORG_DE: Record<string, string> = { [VA]: ORG, [VO]: OTRA_ORG }

/** `Staff.active` de cada persona. Quien no está aquí no existe. */
const PERSONAS: Record<string, boolean> = {
  'dueno-suc': true,
  cajero: true,
  'dueno-org': true,
  'dueno-org-baja': false, // su fila de dueño sigue viva; la PERSONA está dada de baja
  'dueno-otra-org': true,
}
/** Filas `StaffVenue`. `dueno-org` no tiene fila en ninguna tienda. */
const SUCURSAL = [
  { staffId: 'dueno-suc', venueId: VA, role: 'OWNER', active: true },
  { staffId: 'cajero', venueId: VA, role: 'CASHIER', active: true },
  { staffId: 'dueno-otra-org', venueId: VO, role: 'OWNER', active: true },
]
/** Filas `StaffOrganization` con rol OWNER. */
const DUENOS = [
  { staffId: 'dueno-org', organizationId: ORG, isActive: true },
  { staffId: 'dueno-org-baja', organizationId: ORG, isActive: true },
  { staffId: 'dueno-otra-org', organizationId: OTRA_ORG, isActive: true },
]
const coincide = (filtro: unknown, valor: string) =>
  filtro === undefined || (typeof filtro === 'string' ? filtro === valor : ((filtro as { in?: string[] }).in ?? []).includes(valor))
const personaActiva = (staffId: string) => PERSONAS[staffId] === true

function como(userId: string, role: string) {
  return { 'x-test-auth-context': JSON.stringify({ userId, orgId: ORG, venueId: VA, role }) }
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/dashboard/venues/:venueId/stores-analysis', storesAnalysisRouter)
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.statusCode ?? 500).json({ message: error.message, code: error.code })
  })
  return app
}

const BASE = `/dashboard/venues/${VA}/stores-analysis`

describe('puerta de la sucursal con el verifyAccess REAL', () => {
  let spies: jest.SpyInstance[] = []

  beforeEach(() => {
    jest.clearAllMocks()
    spies = [
      jest.spyOn(organizationDashboardService, 'getOrgTpvDefaults').mockResolvedValue({}),
      jest.spyOn(organizationDashboardService, 'upsertOrgTpvDefaults').mockResolvedValue({ config: {}, terminalsUpdated: 1 }),
      jest.spyOn(organizationDashboardService, 'upsertOrgAttendanceConfig').mockResolvedValue({ id: 'cfg' } as any),
      jest.spyOn(organizationDashboardService, 'deleteOrgAttendanceConfig').mockResolvedValue(undefined),
    ]

    // Cada doble contesta según TODO su `where` (persona, rol, fila activa, persona activa, tienda, organización): uno
    // que contestara igual a cualquier consulta volvería dueño a cualquiera.
    prismaMock.staff.findUnique.mockImplementation((({ where }: any) =>
      Promise.resolve(where?.id in PERSONAS ? { id: where.id, active: PERSONAS[where.id] } : null)) as any)
    prismaMock.staffVenue.findFirst.mockImplementation((({ where }: any) => {
      const fila = SUCURSAL.find(
        f =>
          f.staffId === where?.staffId &&
          coincide(where?.role, f.role) &&
          (where?.venueId === undefined || where.venueId === f.venueId) &&
          (where?.active !== true || f.active) &&
          (where?.staff?.active !== true || personaActiva(f.staffId)) &&
          (!where?.venue?.organizationId || ORG_DE[f.venueId] === where.venue.organizationId),
      )
      return Promise.resolve(fila ? { id: `sv-${fila.staffId}` } : null)
    }) as any)
    prismaMock.staffVenue.findUnique.mockImplementation((({ where }: any) => {
      const { staffId, venueId } = where?.staffId_venueId ?? {}
      const fila = SUCURSAL.find(f => f.staffId === staffId && f.venueId === venueId)
      return Promise.resolve(
        fila
          ? { role: fila.role, active: fila.active, permissionSetId: null, permissionSet: null, venue: { organizationId: ORG_DE[venueId] } }
          : null,
      )
    }) as any)
    prismaMock.venue.findUnique.mockImplementation((({ where }: any) =>
      Promise.resolve(ORG_DE[where?.id] ? { id: where.id, organizationId: ORG_DE[where.id] } : null)) as any)
    // White-label: sin fila en la tienda, heredado de la org.
    prismaMock.venueModule.findFirst.mockResolvedValue(null)
    prismaMock.organizationModule.findFirst.mockImplementation((({ where }: any) =>
      Promise.resolve(
        ORG_DE[VA] === where?.organizationId && where?.enabled === true && where?.module?.code === 'WHITE_LABEL_DASHBOARD'
          ? { config: null }
          : null,
      )) as any)
    prismaMock.venueRolePermission.findMany.mockResolvedValue([])
    prismaMock.staffOrganization.findMany.mockImplementation((({ where }: any) =>
      Promise.resolve(
        DUENOS.filter(f => f.staffId === where?.staffId && coincide(where?.role, 'OWNER') && (where?.isActive !== true || f.isActive)).map(
          f => ({ organizationId: f.organizationId }),
        ),
      )) as any)
    // La regla estrecha.
    prismaMock.staffOrganization.findFirst.mockImplementation((({ where }: any) => {
      const fila = DUENOS.find(
        f =>
          f.staffId === where?.staffId &&
          f.organizationId === where?.organizationId &&
          coincide(where?.role, 'OWNER') &&
          (where?.isActive !== true || f.isActive) &&
          (where?.staff?.active !== true || personaActiva(f.staffId)),
      )
      return Promise.resolve(fila ? { id: `so-${fila.staffId}` } : null)
    }) as any)
  })
  afterEach(() => spies.forEach(s => s.mockRestore()))

  it('regresión: el OWNER de UNA tienda pasa el acceso a la sucursal y requireOwnerPlus (lee los defaults: 200)', async () => {
    const res = await request(makeApp()).get(`${BASE}/org-tpv-defaults`).set(como('dueno-suc', 'OWNER'))

    expect(res.status).toBe(200)
  })

  it.each([
    [
      'org-tpv-defaults',
      { settings: { enableCardPayments: false } },
      'Sólo el dueño de la organización puede cambiar los valores por defecto de todas las terminales. Pídeselo al dueño.',
    ],
    [
      'org-attendance-config',
      { enableCardPayments: false },
      'Sólo el dueño de la organización puede cambiar la configuración de checador y terminales de todas las sucursales. Pídeselo al dueño.',
    ],
  ])('🔴 …pero al ESCRIBIR %s lo frena la regla nueva (su mensaje, no el de los guardias de antes)', async (ruta, cuerpo, mensaje) => {
    const res = await request(makeApp()).put(`${BASE}/${ruta}`).set(como('dueno-suc', 'OWNER')).send(cuerpo)

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ message: mensaje, code: 'ORG_OWNER_REQUIRED' })
    expect(organizationDashboardService.upsertOrgTpvDefaults).not.toHaveBeenCalled()
    expect(organizationDashboardService.upsertOrgAttendanceConfig).not.toHaveBeenCalled()
  })

  it('el dueño de la org, sin fila en la tienda, pasa los tres candados y guarda', async () => {
    const res = await request(makeApp())
      .put(`${BASE}/org-tpv-defaults`)
      .set(como('dueno-org', 'OWNER'))
      .send({ settings: { enableCardPayments: false } })

    expect(res.status).toBe(200)
    expect(organizationDashboardService.upsertOrgTpvDefaults).toHaveBeenCalledWith(ORG, { enableCardPayments: false }, 'dueno-org', VA)
  })

  it('regresión: un cajero sigue frenado antes, por requireOwnerPlus', async () => {
    const res = await request(makeApp()).put(`${BASE}/org-tpv-defaults`).set(como('cajero', 'CASHIER')).send({ settings: {} })

    expect(res.status).toBe(403)
    expect(res.body.message).toBe('Owner access required')
  })

  it('🔴 DELETE org-attendance-config: al OWNER de UNA tienda también lo frena la regla nueva', async () => {
    const res = await request(makeApp()).delete(`${BASE}/org-attendance-config`).set(como('dueno-suc', 'OWNER'))

    expect(res.status).toBe(403)
    expect(res.body).toEqual({
      message:
        'Sólo el dueño de la organización puede cambiar la configuración de checador y terminales de todas las sucursales. Pídeselo al dueño.',
      code: 'ORG_OWNER_REQUIRED',
    })
    expect(organizationDashboardService.deleteOrgAttendanceConfig).not.toHaveBeenCalled()
  })

  it('DELETE: el dueño de la org, sin fila en la tienda, borra', async () => {
    const res = await request(makeApp()).delete(`${BASE}/org-attendance-config`).set(como('dueno-org', 'OWNER'))

    expect(res.status).toBe(200)
    expect(organizationDashboardService.deleteOrgAttendanceConfig).toHaveBeenCalledWith(ORG, 'dueno-org', VA)
  })

  it.each([
    ['🔴 el dueño de la org dado de baja (fila viva, persona inactiva)', 'dueno-org-baja'],
    ['🔴 el dueño de OTRA organización, por una tienda de ésta', 'dueno-otra-org'],
  ])('%s no escribe nada', async (_l, actor) => {
    const put = await request(makeApp())
      .put(`${BASE}/org-tpv-defaults`)
      .set(como(actor, 'OWNER'))
      .send({ settings: { enableCardPayments: false } })
    const del = await request(makeApp()).delete(`${BASE}/org-attendance-config`).set(como(actor, 'OWNER'))

    expect(put.status).toBe(403)
    expect(del.status).toBe(403)
    expect(organizationDashboardService.upsertOrgTpvDefaults).not.toHaveBeenCalled()
    expect(organizationDashboardService.deleteOrgAttendanceConfig).not.toHaveBeenCalled()
  })
})
