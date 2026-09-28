/**
 * Etapa 3 del KDS: la casilla la cambia quien tiene printers:manage. El candado de rol dejó la ruta; lo que decide
 * si se puede PRENDER (puerta de lanzamiento y plan) vive en el servicio, que la ruta respeta tal cual.
 */
import express from 'express'
import request from 'supertest'
import { ForbiddenError } from '@/errors/AppError'

const mockSet = jest.fn()
const mockUpdate = jest.fn()
jest.mock('@/services/dashboard/printStation.dashboard.service', () => ({
  ...jest.requireActual('@/services/dashboard/printStation.dashboard.service'),
  setKitchenDisplay: (...a: unknown[]) => mockSet(...a),
  updateStation: (...a: unknown[]) => mockUpdate(...a),
}))
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
  it.each(['OWNER', 'ADMIN', 'MANAGER', 'SUPERADMIN'])('%s llega al servicio con su id', async role => {
    mockSet.mockResolvedValue({ id: 's1', hasKitchenDisplay: false })
    const r = await request(app(role)).put('/venues/v1/print-stations/s1/kitchen-display').send({ enabled: false })
    expect(r.status).toBe(200)
    expect(mockSet).toHaveBeenCalledWith('v1', 's1', false, 'staff-1')
  })

  it('si el servicio niega prender (puerta cerrada o sin Pro), la ruta devuelve 403 con su mensaje', async () => {
    mockSet.mockRejectedValue(
      new ForbiddenError('La pantalla de cocina todavía no está disponible para clientes.', 'KITCHEN_DISPLAY_NOT_RELEASED'),
    )
    const r = await request(app('OWNER')).put('/venues/v1/print-stations/s1/kitchen-display').send({ enabled: true })
    expect(r.status).toBe(403)
    expect(r.body.message).toContain('todavía no está disponible')
  })

  it('cuerpo inválido (sin enabled o con campos extra) → 400', async () => {
    const a = app('OWNER')
    expect((await request(a).put('/venues/v1/print-stations/s1/kitchen-display').send({})).status).toBe(400)
    expect((await request(a).put('/venues/v1/print-stations/s1/kitchen-display').send({ enabled: true, name: 'x' })).status).toBe(400)
    expect(mockSet).not.toHaveBeenCalled()
  })

  it('regresión: nadie cuela hasKitchenDisplay por el PUT normal de la estación', async () => {
    const r = await request(app('OWNER')).put('/venues/v1/print-stations/s1').send({ hasKitchenDisplay: true })
    expect(r.status).toBe(400)
    expect(mockUpdate).not.toHaveBeenCalled()
  })
})
