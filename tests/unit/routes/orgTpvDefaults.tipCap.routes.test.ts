/**
 * F0-B, ronda final (I1 de la revisión final = Codex P2-3): el tope de 6 propinas del POS también en las DOS puertas de la
 * organización. Las dos guardan `settings` y lo empujan a TODAS las terminales de la organización (tablets POS incluidas),
 * así que sin esta regla un dueño podía repartir 7 propinas a todas sus sucursales aunque el PUT de UNA terminal lo rechace.
 *
 * Igual que la Task 12: sólo la forma de `tipSuggestions` (LA regla compartida), DESPUÉS de la guarda de acceso, y el resto
 * del cuerpo pasa intacto.
 */
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/access/rolVigente', () => ({
  esSuperadminReal: jest.fn(async () => true),
  esSuperadminDeLaSesion: jest.fn(async (s: any) => s?.role === 'SUPERADMIN'),
}))
jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, _res: any, next: any) => {
    req.authContext = JSON.parse(String(req.headers['x-test-auth-context']))
    next()
  },
}))
// La guarda de marca blanca: deja en `req.access` el rol RESUELTO para el negocio, como el middleware real.
jest.mock('@/middlewares/verifyAccess.middleware', () => ({
  verifyAccess: () => (req: any, _res: any, next: any) => {
    req.access = { role: req.headers['x-test-access-role'] ?? req.authContext?.role }
    next()
  },
}))
jest.mock('@/services/organization-dashboard/organizationDashboard.service', () => ({
  organizationDashboardService: { upsertOrgTpvDefaults: jest.fn(async () => ({ config: {}, terminalsUpdated: 3 })) },
}))

import storesAnalysisRouter from '@/routes/dashboard/storesAnalysis.routes'
import organizationConfigRouter from '@/routes/dashboard/organizationConfig.routes'
import { organizationDashboardService } from '@/services/organization-dashboard/organizationDashboard.service'

const ORG_ID = 'org-1'
const VENUE_ID = 'venue-1'
const upsert = organizationDashboardService.upsertOrgTpvDefaults as jest.Mock

const app = express()
app.use(express.json())
app.use('/dashboard/venues/:venueId/stores-analysis', storesAnalysisRouter)
app.use('/dashboard/organizations/:orgId', organizationConfigRouter)
app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  res.status(error.statusCode ?? 500).json({ message: error.message })
})

const PUERTAS = [
  ['stores-analysis (venue)', `/dashboard/venues/${VENUE_ID}/stores-analysis/org-tpv-defaults`],
  ['organizations (org)', `/dashboard/organizations/${ORG_ID}/org-tpv-defaults`],
] as const

const guardar = (ruta: string, body: unknown, rol = 'OWNER') =>
  request(app)
    .put(ruta)
    .set('x-test-auth-context', JSON.stringify({ userId: 'u1', orgId: ORG_ID, venueId: VENUE_ID, role: rol }))
    .send(body as object)

beforeEach(() => {
  upsert.mockClear()
  prismaMock.venue.findUnique.mockResolvedValue({ organizationId: ORG_ID } as any) // getOrgIdFromVenue (stores-analysis)
  // Desde develop (17-oct) las dos puertas piden al DUEÑO DE LA ORGANIZACIÓN (`soloElDuenoDeLaOrgCambia`): fila OWNER
  // activa en StaffOrganization. Aquí u1 lo es; los casos de 403 de abajo lo quitan.
  prismaMock.staffOrganization.findFirst.mockResolvedValue({ id: 'so-owner' } as any)
})

describe.each(PUERTAS)('PUT org-tpv-defaults por %s — el tope de 6 propinas del POS', (_puerta, ruta) => {
  it('🔴 siete porcentajes → 400 en español, y no se guarda ni se reparte nada', async () => {
    const r = await guardar(ruta, { settings: { showTipScreen: true, tipSuggestions: [5, 10, 15, 20, 25, 30, 35] } })

    expect(r.status).toBe(400)
    expect(r.body.message).toContain('No puedes ofrecer más de 6 porcentajes de propina')
    expect(upsert).not.toHaveBeenCalled()
  })

  it('seis porcentajes sí se guardan', async () => {
    const r = await guardar(ruta, { settings: { tipSuggestions: [5, 10, 15, 18, 20, 25] } })

    expect(r.status).toBe(200)
    // Lo que se revisa aquí son la org y los ajustes; detrás van quién lo hizo (y en la sucursal, desde dónde).
    expect(upsert.mock.calls[0].slice(0, 2)).toEqual([ORG_ID, { tipSuggestions: [5, 10, 15, 18, 20, 25] }])
  })

  it('un cuerpo SIN propinas pasa intacto: el resto de llaves llega al servicio tal cual', async () => {
    const settings = { showTipScreen: false, requireAvoqadoServerForCardPayment: true, trackPromoterLocation: null, llaveNueva: 'x' }
    const r = await guardar(ruta, { settings })

    expect(r.status).toBe(200)
    expect(upsert.mock.calls[0].slice(0, 2)).toEqual([ORG_ID, settings])
  })
})

describe('el permiso va ANTES que la forma (como la Task 12): sin acceso es 403, no un 400 que describa el cuerpo', () => {
  const sieteTips = { settings: { tipSuggestions: [1, 2, 3, 4, 5, 6, 7] } }

  it('stores-analysis: una mesera de ese negocio', async () => {
    const r = await guardar(PUERTAS[0][1], sieteTips, 'WAITER')
    expect(r.status).toBe(403)
  })

  it('organizations: quien no es dueño en la organización', async () => {
    prismaMock.staffOrganization.findFirst.mockResolvedValue(null)
    const r = await guardar(PUERTAS[1][1], sieteTips, 'MANAGER')
    expect(r.status).toBe(403)
    expect(upsert).not.toHaveBeenCalled()
  })

  it.each(PUERTAS)('%s: la dueña de UNA sucursal (no de la organización) recibe 403, no el 400 de las propinas', async (_puerta, ruta) => {
    prismaMock.staffOrganization.findFirst.mockResolvedValue(null)
    const r = await guardar(ruta, sieteTips, 'OWNER')
    expect(r.status).toBe(403)
    expect(r.body.message).not.toContain('porcentajes de propina')
    expect(upsert).not.toHaveBeenCalled()
  })
})
