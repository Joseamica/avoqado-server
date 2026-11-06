/**
 * «Cliente de antes» de toda la organización bajo /superadmin (CRM C1, tarea 9). El SUPERADMIN nunca llama a
 * /dashboard/superadmin: esta ruta reusa el MISMO controlador y el MISMO esquema, y la guarda el padre (token + rol).
 */
import express from 'express'
import type { Server } from 'http'
import request from 'supertest'

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, _res: any, next: any) => {
    req.authContext = { userId: 'u1', role: req.header('x-rol') ?? 'VIEWER' }
    next()
  },
}))
jest.mock('@/services/access/rolVigente', () => ({ rolVigente: async (ctx: any) => ctx.role }))
const mockGrandfathered = jest.fn((req: any, res: any) => res.status(200).json({ success: true, org: req.params.organizationId }))
// El esquema vive en su archivo de esquemas: esta ruta ya no arma el router legacy, sólo usa este controlador.
jest.mock('@/controllers/dashboard/organizations.superadmin.controller', () => ({
  setOrganizationPlanGrandfathered: (req: any, res: any) => mockGrandfathered(req, res),
}))

import superadminRoutes from '@/routes/superadmin.routes'

const ORG = 'cmhx0000000000000000000a1'
const url = `/api/v1/superadmin/organizations/${ORG}/plan/grandfathered`
let server: Server
beforeAll(() => {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/superadmin', superadminRoutes)
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ message: err.message }))
  server = app.listen(0)
})
afterAll(done => {
  server.close(done)
})
beforeEach(() => jest.clearAllMocks())

describe('POST /superadmin/organizations/:organizationId/plan/grandfathered', () => {
  it('un vendedor del CRM (no superadmin) recibe 403 y el controlador no corre', async () => {
    const res = await request(server).post(url).set('x-rol', 'MANAGER').send({ grandfathered: true })
    expect(res.status).toBe(403)
    expect(mockGrandfathered).not.toHaveBeenCalled()
  })

  it('superadmin: 200 y llama al controlador con la organización', async () => {
    const res = await request(server).post(url).set('x-rol', 'SUPERADMIN').send({ grandfathered: true })
    expect(res.status).toBe(200)
    expect(res.body.org).toBe(ORG)
    expect(mockGrandfathered).toHaveBeenCalledTimes(1)
  })

  it('grandfathered faltante: 400 con el mensaje de hoy', async () => {
    const res = await request(server).post(url).set('x-rol', 'SUPERADMIN').send({})
    expect(res.status).toBe(400)
    expect(res.body.message).toContain('El campo "grandfathered" es requerido')
    expect(mockGrandfathered).not.toHaveBeenCalled()
  })
})
