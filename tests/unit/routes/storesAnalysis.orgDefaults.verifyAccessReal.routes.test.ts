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
const VA = 'venue-a'

/** Filas `StaffVenue` de la tienda A. */
const SUCURSAL: Record<string, string> = { 'dueno-suc': 'OWNER', cajero: 'CASHIER' }
/** Dueños ACTIVOS de la org (`StaffOrganization` OWNER). `dueno-org` no tiene fila en ninguna tienda. */
const DUENOS_DE_LA_ORG = new Set(['dueno-org'])

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
    ]

    // Superadmin: nadie aquí lo es (la consulta pide rol SUPERADMIN).
    prismaMock.staffVenue.findFirst.mockImplementation((({ where }: any) =>
      Promise.resolve(where?.role === 'SUPERADMIN' ? null : SUCURSAL[where?.staffId] ? { id: 'sv' } : null)) as any)
    prismaMock.staffVenue.findUnique.mockImplementation((({ where }: any) => {
      const { staffId, venueId } = where?.staffId_venueId ?? {}
      const rol = venueId === VA ? SUCURSAL[staffId] : undefined
      return Promise.resolve(
        rol ? { role: rol, active: true, permissionSetId: null, permissionSet: null, venue: { organizationId: ORG } } : null,
      )
    }) as any)
    prismaMock.venue.findUnique.mockImplementation((({ where }: any) =>
      Promise.resolve(where?.id === VA ? { id: VA, organizationId: ORG } : null)) as any)
    // White-label: sin fila en la tienda, heredado de la org.
    prismaMock.venueModule.findFirst.mockResolvedValue(null)
    prismaMock.organizationModule.findFirst.mockImplementation((({ where }: any) =>
      Promise.resolve(
        where?.organizationId === ORG && where?.enabled === true && where?.module?.code === 'WHITE_LABEL_DASHBOARD'
          ? { config: null }
          : null,
      )) as any)
    prismaMock.venueRolePermission.findMany.mockResolvedValue([])
    prismaMock.staff.findUnique.mockImplementation((({ where }: any) => Promise.resolve({ id: where?.id, active: true })) as any)
    prismaMock.staffOrganization.findMany.mockImplementation((({ where }: any) =>
      Promise.resolve(
        where?.role === 'OWNER' && where?.isActive === true && DUENOS_DE_LA_ORG.has(where?.staffId) ? [{ organizationId: ORG }] : [],
      )) as any)
    // La regla estrecha.
    prismaMock.staffOrganization.findFirst.mockImplementation((({ where }: any) =>
      Promise.resolve(
        where?.organizationId === ORG &&
          where?.role === 'OWNER' &&
          where?.isActive === true &&
          where?.staff?.active === true &&
          DUENOS_DE_LA_ORG.has(where?.staffId)
          ? { id: 'so' }
          : null,
      )) as any)
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
})
