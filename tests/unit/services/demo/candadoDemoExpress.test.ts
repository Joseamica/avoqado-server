/**
 * La lista del candado se compara contra cómo Express RECONOCE la ruta, no contra cómo se escribe. Codex r4 (hallazgo 1):
 * `PATCH /api/v1/dashboard/x%2Fy/account` llegaba al controlador (Express decodifica `x/y` como UN parámetro) y la lista
 * no la veía. Esta prueba pasa por un router de Express real, igual que en producción.
 */
import express, { Router } from 'express'
import request from 'supertest'
import prisma from '@/utils/prismaClient'
import { revisarCandadoDemo, __olvidarNegociosDemoParaPruebas } from '@/services/demo/candadoDemo'

const db = prisma as unknown as { venue: { findUnique: jest.Mock }; staff: { findUnique: jest.Mock } }
const USUARIO_DEMO = 'cusrdemo00000000000000000'
const llegoAlControlador = jest.fn()

function app() {
  const a = express()
  a.use(express.json())
  const dashboard = Router()
  // Igual que authenticateTokenMiddleware: el token pone authContext y el candado corre antes de la ruta.
  dashboard.use(async (req, res, next) => {
    ;(req as any).authContext = { userId: USUARIO_DEMO, venueId: 'cviejo00000000000000000aa', role: 'OWNER' }
    const r = await revisarCandadoDemo(req)
    if (!r.ok) return void res.status(r.status).json({ code: r.code, message: r.message })
    next()
  })
  dashboard.patch('/:venueId/account', (_req, res) => {
    llegoAlControlador()
    res.json({ ok: true })
  })
  dashboard.post('/venues/:venueId/team', (_req, res) => {
    llegoAlControlador()
    res.json({ ok: true })
  })
  a.use('/api/v1/dashboard', dashboard)
  return a
}

beforeEach(() => {
  jest.clearAllMocks()
  __olvidarNegociosDemoParaPruebas()
  db.staff.findUnique.mockResolvedValue({ email: 'bloom@demo.avoqado.io' })
  db.venue.findUnique.mockResolvedValue(null)
})

it.each([
  ['PATCH', '/api/v1/dashboard/x%2Fy/account'],
  ['PATCH', '/api/v1/dashboard/x%2fy/ACCOUNT'],
  ['PATCH', '/api/v1/dashboard/cviejo00000000000000000aa/account/'],
  ['POST', '/api/v1/dashboard/venues/x%2Fy/team'],
])('🔴 %s %s: Express la reconoce y el candado también (403, el controlador no corre)', async (method, url) => {
  const res = await (request(app()) as any)[method.toLowerCase()](url).send({ password: 'nueva-clave' })
  expect(res.status).toBe(403)
  expect(res.body.code).toBe('NEGOCIO_DEMO')
  expect(llegoAlControlador).not.toHaveBeenCalled()
})

it('regresión: una persona real sí llega a su cuenta', async () => {
  db.staff.findUnique.mockResolvedValue({ email: 'dueno@negocio.mx' })
  const res = await request(app()).patch('/api/v1/dashboard/creal0000000000000000000a/account').send({ firstName: 'Ana' })
  expect(res.status).toBe(200)
  expect(llegoAlControlador).toHaveBeenCalledTimes(1)
})
