import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'

import { prismaMock } from '@tests/__helpers__/setup'

/** Códigos por persona: la puerta es `requireOrgManager` (real); sólo se simulan la autenticación y el servicio. */
const generarCodigosMock = jest.fn()
jest.mock('@/services/tpv/campo/celular/codigoDeCelular.service', () => ({
  generarCodigos: (...a: unknown[]) => generarCodigosMock(...a),
}))
const desvincularMock = jest.fn()
jest.mock('@/services/tpv/campo/celular/desvincularCelular.service', () => ({
  desvincularCelular: (...a: unknown[]) => desvincularMock(...a),
}))
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

const ORG = 'org-a'
const SUCURSAL = [
  { staffId: 'promotor', role: 'WAITER' },
  { staffId: 'gerente', role: 'MANAGER' },
]
function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/dashboard/organizations', organizationDashboardRoutes)
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.statusCode ?? 500).json({ message: error.message, code: error.code })
  })
  return app
}
const como = (userId: string, role: string) => ({ 'x-test-auth-context': JSON.stringify({ userId, orgId: ORG, venueId: 'v1', role }) })
const URL = `/dashboard/organizations/${ORG}/celulares-de-campo/codigos`

beforeEach(() => {
  jest.clearAllMocks()
  generarCodigosMock.mockResolvedValue({ generados: [], omitidos: [], restantes: 0 })
  prismaMock.staff.findUnique.mockResolvedValue({ active: true, firstName: 'Ana', lastName: 'P' } as any)
  prismaMock.staffVenue.findFirst.mockImplementation((({ where }: any) => {
    const f = SUCURSAL.find(
      x => x.staffId === where?.staffId && (where?.role === undefined || (where.role.in ?? [where.role]).includes(x.role)),
    )
    return Promise.resolve(f ? { id: 'sv' } : null)
  }) as any)
  // Miembros de la organización: el promotor es MEMBER; el gerente, MEMBER con sucursal MANAGER.
  prismaMock.staffOrganization.findFirst.mockImplementation((({ where }: any) => {
    const f = { promotor: 'MEMBER', gerente: 'MEMBER' }[where?.staffId as string]
    const ok = f && (where?.role === undefined || (typeof where.role === 'string' ? where.role === f : (where.role.in ?? []).includes(f)))
    return Promise.resolve(ok ? { id: 'so' } : null)
  }) as any)
  prismaMock.staffOrganization.findUnique.mockResolvedValue(null as any)
  prismaMock.staffVenue.findUnique.mockResolvedValue(null as any)
})

describe('POST .../celulares-de-campo/codigos', () => {
  it('un WAITER recibe 403 insufficient_role', async () => {
    const res = await request(makeApp())
      .post(URL)
      .set(como('promotor', 'WAITER'))
      .send({ staffIds: ['a'] })
    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ success: false, error: 'insufficient_role' })
    expect(generarCodigosMock).not.toHaveBeenCalled()
  })

  it('101 staffIds → 400', async () => {
    const staffIds = Array.from({ length: 101 }, (_, i) => `s${i}`)
    const res = await request(makeApp()).post(URL).set(como('gerente', 'MANAGER')).send({ staffIds })
    expect(res.status).toBe(400)
    expect(generarCodigosMock).not.toHaveBeenCalled()
  })

  it('un supervisor genera: 200 { success, data } y generadoPor = su userId', async () => {
    const res = await request(makeApp())
      .post(URL)
      .set(como('gerente', 'MANAGER'))
      .send({ staffIds: ['a'] })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, data: { generados: [], omitidos: [], restantes: 0 } })
    expect(generarCodigosMock).toHaveBeenCalledWith({ organizationId: ORG, generadoPor: 'gerente', staffIds: ['a'] })
  })

  it('todosLosSinCelular: true pasa la bandera', async () => {
    const res = await request(makeApp()).post(URL).set(como('gerente', 'MANAGER')).send({ todosLosSinCelular: true })
    expect(res.status).toBe(200)
    expect(generarCodigosMock).toHaveBeenCalledWith({ organizationId: ORG, generadoPor: 'gerente', todosLosSinCelular: true })
  })
})

describe('POST .../celulares-de-campo/:celularId/desvincular', () => {
  const URL_DESVINCULAR = `/dashboard/organizations/${ORG}/celulares-de-campo/cel1/desvincular`
  const resultado = { desvinculadoAt: 'x', graciaHasta: 'y', porSubir: 2, huellasReportadas: 2, yaEstaba: false }

  it('un WAITER recibe 403 y no se desvincula nada', async () => {
    const res = await request(makeApp()).post(URL_DESVINCULAR).set(como('promotor', 'WAITER')).send({})
    expect(res.status).toBe(403)
    expect(desvincularMock).not.toHaveBeenCalled()
  })

  it('un supervisor desvincula: 200 { success, data } con motivo PANEL, su userId y la organización de la ruta', async () => {
    desvincularMock.mockResolvedValue(resultado)
    const res = await request(makeApp()).post(URL_DESVINCULAR).set(como('gerente', 'MANAGER')).send({})
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, data: resultado })
    expect(desvincularMock).toHaveBeenCalledWith({ celularId: 'cel1', organizationId: ORG, motivo: 'PANEL', porStaffId: 'gerente' })
  })
})
