/**
 * La casilla de pantalla de cocina sólo la cambia SUPERADMIN en la etapa 1 (spec 2026-09-24 §4):
 * el candado vive en la RUTA, y el PUT normal de la estación no deja colarla.
 */
import express from 'express'
import request from 'supertest'

const mockSet = jest.fn()
const mockUpdate = jest.fn()
jest.mock('@/services/dashboard/printStation.dashboard.service', () => ({
  ...jest.requireActual('@/services/dashboard/printStation.dashboard.service'),
  setKitchenDisplay: (...a: unknown[]) => mockSet(...a),
  updateStation: (...a: unknown[]) => mockUpdate(...a),
}))
// checkPermission deja pasar: esta prueba mide el candado de ROL de la ruta nueva, no los permisos.
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  checkPermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}))

import printStationRoutes from '@/routes/dashboard/printStation.routes'

function app(role: string) {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => {
    ;(req as any).authContext = { userId: 'staff-1', role, venueId: 'v1' }
    next()
  })
  a.use('/venues/:venueId/print-stations', printStationRoutes)
  a.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ message: err.message }))
  return a
}

beforeEach(() => {
  mockSet.mockReset()
  mockUpdate.mockReset()
})

describe('PUT /print-stations/:stationId/kitchen-display', () => {
  it('SUPERADMIN la cambia', async () => {
    mockSet.mockResolvedValue({ id: 's1', hasKitchenDisplay: true })
    const r = await request(app('SUPERADMIN')).put('/venues/v1/print-stations/s1/kitchen-display').send({ enabled: true })
    expect(r.status).toBe(200)
    expect(mockSet).toHaveBeenCalledWith('v1', 's1', true, 'staff-1')
  })

  it.each(['OWNER', 'ADMIN', 'MANAGER'])('%s recibe 403 y no se escribe nada', async role => {
    const r = await request(app(role)).put('/venues/v1/print-stations/s1/kitchen-display').send({ enabled: true })
    expect(r.status).toBe(403)
    expect(mockSet).not.toHaveBeenCalled()
  })

  it('cuerpo inválido (sin enabled o con campos extra) → 400', async () => {
    const a = app('SUPERADMIN')
    expect((await request(a).put('/venues/v1/print-stations/s1/kitchen-display').send({})).status).toBe(400)
    expect((await request(a).put('/venues/v1/print-stations/s1/kitchen-display').send({ enabled: true, name: 'x' })).status).toBe(400)
    expect(mockSet).not.toHaveBeenCalled()
  })

  it('regresión: un OWNER no puede colar hasKitchenDisplay por el PUT normal de la estación', async () => {
    const r = await request(app('OWNER')).put('/venues/v1/print-stations/s1').send({ hasKitchenDisplay: true })
    expect(r.status).toBe(400)
    expect(mockUpdate).not.toHaveBeenCalled()
  })
})
