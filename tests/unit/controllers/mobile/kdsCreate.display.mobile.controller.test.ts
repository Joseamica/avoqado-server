import type { NextFunction, Request, Response } from 'express'
import { createKdsOrder } from '@/controllers/mobile/kds.mobile.controller'
import * as kdsService from '@/services/mobile/kds.mobile.service'

jest.mock('@/services/mobile/kds.mobile.service', () => ({ createKdsOrder: jest.fn() }))
const createMock = kdsService.createKdsOrder as unknown as jest.Mock

function respuesta() {
  const res = { status: jest.fn(), json: jest.fn() }
  res.status.mockReturnValue(res)
  return res
}
async function llamar(body: Record<string, unknown>) {
  const req = { params: { venueId: 'venue-1' }, body } as unknown as Request
  const res = respuesta()
  const next = jest.fn() as unknown as NextFunction
  await createKdsOrder(req, res as unknown as Response, next)
  return { res, next }
}
const venta = { orderNumber: 'A1', items: [{ productName: 'Café', quantity: 1 }] }

beforeEach(() => createMock.mockReset())

describe('POST /kds/orders — respuesta con y sin pantalla', () => {
  it('sin pantalla: 200 con data null y created false (las apps viejas sólo miran el 2xx)', async () => {
    createMock.mockResolvedValue(null)
    const { res } = await llamar(venta)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ success: true, data: null, created: false })
  })

  it('con pantalla: 201 como hoy, más created true', async () => {
    const orden = { id: 'k1', orderNumber: 'A1' }
    createMock.mockResolvedValue(orden)
    const { res } = await llamar(venta)
    expect(res.status).toHaveBeenCalledWith(201)
    expect(res.json).toHaveBeenCalledWith({ success: true, data: orden, created: true })
  })

  it('regresión: sin items sigue siendo 400 y no llama al servicio', async () => {
    const { res } = await llamar({ orderNumber: 'A1', items: [] })
    expect(res.status).toHaveBeenCalledWith(400)
    expect(createMock).not.toHaveBeenCalled()
  })
})
