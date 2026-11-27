/**
 * hz:b37dd7ea:D51 — «Descuentos disponibles» de la TPV (Mesas): una cortesía (COMP) que quien llama no puede dar trae
 * `missingPermission: 'orders:comp'`, para que la terminal la pinte en gris en vez de dejarla tocar y recibir el 403 de
 * `checkCortesiaEnDescuento`. Lo decide la MISMA regla del candado (`tienePermisoEnVenue`: dueño de la org, SUPERADMIN,
 * comodines, exclusiones), no la lista de permisos de la terminal.
 */
import express from 'express'
import request from 'supertest'

jest.mock('@/services/tpv/discount.tpv.service')
jest.mock('@/middlewares/permissionFlag.middleware', () => ({
  ...jest.requireActual('@/middlewares/permissionFlag.middleware'),
  tienePermisoEnVenue: jest.fn(),
}))

import * as controller from '@/controllers/tpv/discount.tpv.controller'
import { PLAZO_DEL_PERMISO_DE_CORTESIA_MS } from '@/controllers/tpv/discount.tpv.controller'
import * as discountTpvService from '@/services/tpv/discount.tpv.service'
import { tienePermisoEnVenue } from '@/middlewares/permissionFlag.middleware'

const disponiblesMock = discountTpvService.getAvailableDiscounts as jest.Mock
const permisoMock = tienePermisoEnVenue as jest.Mock

const base = { scope: 'ORDER', description: null, isAutomatic: false, requiresApproval: false }
const porcentaje = { ...base, id: 'd1', name: 'Cliente frecuente', type: 'PERCENTAGE', value: 10, estimatedSavings: 45 }
const cortesia = { ...base, id: 'd2', name: 'Cortesía de la casa', type: 'COMP', value: 100, estimatedSavings: 450 }

function app() {
  const a = express()
  a.get('/venues/:venueId/orders/:orderId/discounts/available', (req, _res, next) => {
    ;(req as any).authContext = { venueId: req.params.venueId, userId: 'staff-1' }
    next()
  })
  a.get('/venues/:venueId/orders/:orderId/discounts/available', controller.getAvailableDiscounts)
  return a
}

const pedir = () => request(app()).get('/venues/v1/orders/o1/discounts/available')

beforeEach(() => jest.clearAllMocks())

describe('GET descuentos disponibles TPV — cortesía sin permiso (D51)', () => {
  it('sin orders:comp, la cortesía trae missingPermission y el porcentaje no', async () => {
    disponiblesMock.mockResolvedValue([porcentaje, cortesia])
    permisoMock.mockResolvedValue(false)

    const res = await pedir()

    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([porcentaje, { ...cortesia, missingPermission: 'orders:comp' }])
    expect(res.body.count).toBe(2)
    expect(permisoMock).toHaveBeenCalledWith(expect.anything(), 'orders:comp')
  })

  it('con orders:comp, la lista sale igual que antes', async () => {
    disponiblesMock.mockResolvedValue([porcentaje, cortesia])
    permisoMock.mockResolvedValue(true)

    const res = await pedir()

    expect(res.body.data).toEqual([porcentaje, cortesia])
  })

  it('si la pregunta del permiso falla, la lista sale igual con la cortesía en gris (Codex r2)', async () => {
    disponiblesMock.mockResolvedValue([porcentaje, cortesia])
    permisoMock.mockRejectedValue(new Error('connection reset'))

    const res = await pedir()

    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([porcentaje, { ...cortesia, missingPermission: 'orders:comp' }])
  })

  it('si la pregunta del permiso se cuelga, la lista sale a tiempo con la cortesía en gris (Codex r3)', async () => {
    jest.useFakeTimers()
    try {
      disponiblesMock.mockResolvedValue([porcentaje, cortesia])
      permisoMock.mockReturnValue(new Promise(() => {}))
      // Directo al controlador (sin supertest): con relojes falsos, la petición HTTP no avanza sola.
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }
      const req = { params: { venueId: 'v1', orderId: 'o1' }, query: {}, authContext: { venueId: 'v1', userId: 'staff-1' } }

      const hecho = controller.getAvailableDiscounts(req as any, res as any, jest.fn())
      await jest.advanceTimersByTimeAsync(PLAZO_DEL_PERMISO_DE_CORTESIA_MS)
      await hecho

      expect(res.status).toHaveBeenCalledWith(200)
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ data: [porcentaje, { ...cortesia, missingPermission: 'orders:comp' }] }),
      )
    } finally {
      jest.useRealTimers()
    }
  })

  it('sin cortesías en la lista no pregunta por el permiso', async () => {
    disponiblesMock.mockResolvedValue([porcentaje])

    const res = await pedir()

    expect(res.body.data).toEqual([porcentaje])
    expect(permisoMock).not.toHaveBeenCalled()
  })
})
