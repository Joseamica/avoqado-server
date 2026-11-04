import express from 'express'
import request from 'supertest'

const mockPermisosPedidos: string[] = []
let mockNiega = false
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkPermission.middleware'),
  checkPermission: (p: string) => (_req: any, res: any, next: any) => {
    mockPermisosPedidos.push(p)
    if (mockNiega) return res.status(403).json({ error: 'Forbidden' })
    next()
  },
}))
jest.mock('@/controllers/dashboard/exports.dashboard.controller', () => {
  const ok = jest.fn((_req: any, res: any) => res.json({ ok: true }))
  return { pedirExporte: ok, estadoExporte: ok, descargarExporte: ok, listarExportes: ok, reintentarExporte: ok }
})

import prisma from '@/utils/prismaClient'
import exportsRoutes from '@/routes/dashboard/exports.routes'
import { pedirExporte } from '@/controllers/dashboard/exports.dashboard.controller'

const app = express()
app.use(express.json())
app.use('/venues/:venueId/exports', exportsRoutes)

describe('rutas de exportes: el permiso es el del exporte', () => {
  beforeEach(() => {
    mockPermisosPedidos.length = 0
    mockNiega = false
    ;(pedirExporte as jest.Mock).mockClear()
  })

  it('POST /cobros pide payments:read (una cajera exporta sin reports:read)', async () => {
    await request(app).post('/venues/v1/exports/cobros').send({}).expect(200)
    expect(mockPermisosPedidos).toEqual(['payments:read'])
  })
  it('POST /ventas-detalladas pide reports:read', async () => {
    await request(app).post('/venues/v1/exports/ventas-detalladas').send({}).expect(200)
    expect(mockPermisosPedidos).toEqual(['reports:read'])
  })
  it('🔴 sin el permiso en el negocio de la URL, el controller (y `pedir`) ni se llaman', async () => {
    mockNiega = true
    await request(app).post('/venues/v2/exports/cobros').send({}).expect(403)
    expect(pedirExporte).not.toHaveBeenCalled()
  })
  it('estado, descarga y reintento piden el permiso del exporte GUARDADO, buscado dentro del negocio de la URL', async () => {
    ;(prisma.exportRun.findFirst as jest.Mock).mockResolvedValue({ kind: 'cobros' })
    await request(app).get('/venues/v1/exports/run1/status').expect(200)
    await request(app).get('/venues/v1/exports/run1/download').expect(200)
    await request(app).post('/venues/v1/exports/run1/retry').expect(200)
    expect(mockPermisosPedidos).toEqual(['payments:read', 'payments:read', 'payments:read'])
    expect((prisma.exportRun.findFirst as jest.Mock).mock.calls[0][0].where).toEqual({ id: 'run1', venueId: 'v1' })
  })
  it('un pedido que no existe en ese negocio ⇒ 404 sin pedir permiso', async () => {
    ;(prisma.exportRun.findFirst as jest.Mock).mockResolvedValue(null)
    await request(app).get('/venues/v1/exports/otro/status').expect(404)
    expect(mockPermisosPedidos).toEqual([])
  })
  it('la lista exige ?kind= y pide su permiso', async () => {
    await request(app).get('/venues/v1/exports?kind=cobros').expect(200)
    expect(mockPermisosPedidos).toEqual(['payments:read'])
    await request(app).get('/venues/v1/exports').expect(404)
  })
})
