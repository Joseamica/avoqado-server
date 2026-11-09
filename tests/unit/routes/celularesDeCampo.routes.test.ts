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
const listarCelularesMock = jest.fn()
jest.mock('@/services/tpv/campo/celular/celularesDeLaOrganizacion.service', () => ({
  listarCelularesDeCampo: (...a: unknown[]) => listarCelularesMock(...a),
}))
const listarMock = jest.fn()
const resolverMock = jest.fn()
jest.mock('@/services/tpv/campo/celular/graciaDelCelular.service', () => ({
  listarRetenidos: (...a: unknown[]) => listarMock(...a),
  resolverRetenido: (...a: unknown[]) => resolverMock(...a),
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

describe('POST .../celulares-de-campo/codigos · venueId (Tarea 8)', () => {
  it('todosLosSinCelular con venueId pasa los dos', async () => {
    const res = await request(makeApp()).post(URL).set(como('gerente', 'MANAGER')).send({ todosLosSinCelular: true, venueId: 'v1' })
    expect(res.status).toBe(200)
    expect(generarCodigosMock).toHaveBeenCalledWith({
      organizationId: ORG,
      generadoPor: 'gerente',
      todosLosSinCelular: true,
      venueId: 'v1',
    })
  })

  it('venueId con staffIds → 400 (sólo va con todosLosSinCelular)', async () => {
    const res = await request(makeApp())
      .post(URL)
      .set(como('gerente', 'MANAGER'))
      .send({ staffIds: ['a'], venueId: 'v1' })
    expect(res.status).toBe(400)
  })
})

describe('GET .../celulares-de-campo (la lista, Tarea 8)', () => {
  const LISTA = `/dashboard/organizations/${ORG}/celulares-de-campo`
  const salida = { disponible: true, items: [], total: 0, conteos: { SIN_CELULAR: 0, CODIGO_SIN_USAR: 0, ACTIVO: 0 }, porRevisar: 0 }

  it('un WAITER recibe 403', async () => {
    expect((await request(makeApp()).get(LISTA).set(como('promotor', 'WAITER'))).status).toBe(403)
    expect(listarCelularesMock).not.toHaveBeenCalled()
  })

  it('sin parámetros: página 1 de 50 y la organización de la ruta → { success, data }', async () => {
    listarCelularesMock.mockResolvedValue(salida)
    const res = await request(makeApp()).get(LISTA).set(como('gerente', 'MANAGER'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, data: salida })
    expect(listarCelularesMock).toHaveBeenCalledWith(ORG, { page: 1, pageSize: 50 })
  })

  it('pasa q, venueId, estado y la paginación', async () => {
    listarCelularesMock.mockResolvedValue(salida)
    const res = await request(makeApp()).get(`${LISTA}?q=ana&venueId=v1&estado=ACTIVO&page=2&pageSize=20`).set(como('gerente', 'MANAGER'))
    expect(res.status).toBe(200)
    expect(listarCelularesMock).toHaveBeenCalledWith(ORG, { q: 'ana', venueId: 'v1', estado: 'ACTIVO', page: 2, pageSize: 20 })
  })

  it('pageSize 101 o estado desconocido → 400', async () => {
    expect((await request(makeApp()).get(`${LISTA}?pageSize=101`).set(como('gerente', 'MANAGER'))).status).toBe(400)
    expect((await request(makeApp()).get(`${LISTA}?estado=XX`).set(como('gerente', 'MANAGER'))).status).toBe(400)
    expect(listarCelularesMock).not.toHaveBeenCalled()
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

describe('«Por revisar»: GET …/retenidos y POST …/retenidos/:retenidoId/resolver (Tarea 7)', () => {
  const BASE = `/dashboard/organizations/${ORG}/celulares-de-campo/retenidos`

  it('un WAITER recibe 403', async () => {
    expect((await request(makeApp()).get(BASE).set(como('promotor', 'WAITER'))).status).toBe(403)
    expect((await request(makeApp()).post(`${BASE}/r1/resolver`).set(como('promotor', 'WAITER')).send({ accion: 'APLICAR' })).status).toBe(
      403,
    )
    expect(listarMock).not.toHaveBeenCalled()
    expect(resolverMock).not.toHaveBeenCalled()
  })

  it('lista con estado como lista separada por coma y la paginación por omisión (50) → { success, data: { items, total } }', async () => {
    listarMock.mockResolvedValue({ items: [], total: 0 })
    const res = await request(makeApp()).get(`${BASE}?estado=PENDIENTE,APLICANDO&staffId=s1`).set(como('gerente', 'MANAGER'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, data: { items: [], total: 0 } })
    expect(listarMock).toHaveBeenCalledWith(ORG, {
      staffId: 's1',
      venueId: undefined,
      estado: ['PENDIENTE', 'APLICANDO'],
      page: 1,
      pageSize: 50,
    })
  })

  it('un estado que no existe, pageSize de 101 o un filtro desconocido → 400', async () => {
    for (const q of ['estado=PENDIENTE,OTRO', 'pageSize=101', 'page=0', 'orden=x']) {
      expect((await request(makeApp()).get(`${BASE}?${q}`).set(como('gerente', 'MANAGER'))).status).toBe(400)
    }
    expect(listarMock).not.toHaveBeenCalled()
  })

  it('resolver: pasa el retenido, la organización de la ruta y quién lo resuelve', async () => {
    resolverMock.mockResolvedValue({ estado: 'DESCARTADO', repetida: false })
    const res = await request(makeApp())
      .post(`${BASE}/r1/resolver`)
      .set(como('gerente', 'MANAGER'))
      .send({ accion: 'DESCARTAR', nota: 'prueba' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, data: { estado: 'DESCARTADO', repetida: false } })
    expect(resolverMock).toHaveBeenCalledWith({
      retenidoId: 'r1',
      organizationId: ORG,
      accion: 'DESCARTAR',
      nota: 'prueba',
      porStaffId: 'gerente',
    })
  })

  it('resolver: 422 con sus datos al nivel de code; acción inválida o nota de más de 500 → 400', async () => {
    const { ValidationError } = jest.requireActual('@/errors/AppError')
    resolverMock.mockRejectedValue(new ValidationError('No se pudo aplicar.', 'NO_SE_PUDO_APLICAR', { motivo: 'PERSONA_SIN_ASIGNACION' }))
    const res = await request(makeApp()).post(`${BASE}/r1/resolver`).set(como('gerente', 'MANAGER')).send({ accion: 'APLICAR' })
    expect(res.status).toBe(422)
    expect(res.body).toEqual({ code: 'NO_SE_PUDO_APLICAR', message: 'No se pudo aplicar.', motivo: 'PERSONA_SIN_ASIGNACION' })
    resolverMock.mockClear()
    expect((await request(makeApp()).post(`${BASE}/r1/resolver`).set(como('gerente', 'MANAGER')).send({ accion: 'BORRAR' })).status).toBe(
      400,
    )
    expect(
      (
        await request(makeApp())
          .post(`${BASE}/r1/resolver`)
          .set(como('gerente', 'MANAGER'))
          .send({ accion: 'APLICAR', nota: 'x'.repeat(501) })
      ).status,
    ).toBe(400)
    expect(resolverMock).not.toHaveBeenCalled()
  })
})
