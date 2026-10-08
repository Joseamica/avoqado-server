// tests/unit/routes/commissionRoutes.retiradas.test.ts
/**
 * Fase 3 de pago por servicio (spec §8): las escrituras del flujo viejo de pagos de comisiones se retiran. Durante una
 * versión responden 410 con un código estable (clientes viejos, Codex r1-21); la lectura del historial sigue. Reemplaza
 * las pruebas H1 y H5 de defectos-de-comisiones.integration.test.ts: el flujo que medían ya no existe.
 */
import express from 'express'
import type { Server } from 'http'
import request from 'supertest'

jest.mock('@/services/access/basePlan.service', () => ({ venueHasCommissionsAccess: jest.fn().mockResolvedValue(true) }))
jest.mock('@/middlewares/checkFeatureAccess.middleware', () => ({ checkFeatureAccess: () => (_req: any, _res: any, next: any) => next() }))
jest.mock('@/middlewares/checkPermission.middleware', () => ({ checkPermission: () => (_req: any, _res: any, next: any) => next() }))
// Cada controlador responde con su nombre: así se ve qué ruta sigue llegando al motor y cuál ya no.
jest.mock(
  '@/controllers/dashboard/commission.dashboard.controller',
  () => new Proxy({}, { get: (_t, prop) => (prop === '__esModule' ? true : (_req: any, res: any) => res.json({ handler: String(prop) })) }),
)
jest.mock('@/services/dashboard/commission/commission-resolution.service', () => ({}))
jest.mock('@/services/dashboard/commission/payout-resolution.service', () => ({}))

import commissionRoutes from '@/routes/dashboard/commission.routes'

const base = '/api/v1/dashboard/commissions/venues/venue_ret_1'
let server: Server
beforeAll(() => {
  const app = express()
  app.use('/api/v1/dashboard/commissions', commissionRoutes)
  server = app.listen(0)
})
afterAll(done => {
  server.close(done)
})

const RETIRADAS = [
  '/summaries/s1/approve',
  '/summaries/s1/dispute',
  '/summaries/s1/deduction',
  '/summaries/bulk-approve',
  '/payouts',
  '/payouts/p1/approve',
  '/payouts/p1/process',
  '/payouts/p1/complete',
  '/payouts/p1/fail',
  '/payouts/p1/cancel',
]

describe('escrituras retiradas del flujo viejo de comisiones (fase 3, spec §8)', () => {
  it.each(RETIRADAS)('POST %s responde 410 MOVIDO_A_PAGO_AL_PERSONAL sin llegar al motor viejo', async ruta => {
    const res = await request(server).post(`${base}${ruta}`).send({})
    expect(res.status).toBe(410)
    expect(res.body).toEqual({
      code: 'MOVIDO_A_PAGO_AL_PERSONAL',
      message: 'Las comisiones ahora se pagan en el recibo de Pago al personal',
    })
  })

  it('la lectura del historial de pagos sigue llegando a su controlador', async () => {
    for (const [ruta, handler] of [
      ['/payouts', 'getPayouts'],
      ['/payouts/stats', 'getPayoutStats'],
      ['/payouts/p1', 'getPayoutById'],
      ['/summaries', 'getSummaries'],
    ]) {
      const res = await request(server).get(`${base}${ruta}`)
      expect({ ruta, status: res.status, body: res.body }).toEqual({ ruta, status: 200, body: { handler } })
    }
  })

  it('recalcular un resumen y la agregación manual no se retiran: no mueven dinero', async () => {
    expect((await request(server).post(`${base}/summaries/s1/recalculate`)).body).toEqual({ handler: 'recalculateSummary' })
    expect((await request(server).post(`${base}/aggregate`)).body).toEqual({ handler: 'triggerAggregation' })
  })
})
