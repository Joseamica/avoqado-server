/**
 * `GET /mobile/venues/:venueId/kds/orders` — el total real viaja en `X-Total-Count`.
 *
 * El tablero de cocina devuelve como máximo KDS_LIST_MAX comandas (las más recientes). El total va en
 * un ENCABEZADO y no en el cuerpo para no tocar la forma que leen las apps de la calle (`data` es un
 * arreglo), y un recorte queda avisado en el log por negocio.
 */

import type { NextFunction, Request, Response } from 'express'

import { listKdsOrders } from '@/controllers/mobile/kds.mobile.controller'
import * as kdsService from '@/services/mobile/kds.mobile.service'
import logger from '@/config/logger'

jest.mock('@/services/mobile/kds.mobile.service', () => ({
  listKdsOrders: jest.fn(),
  countKdsOrders: jest.fn(),
}))

const listMock = kdsService.listKdsOrders as unknown as jest.Mock
const countMock = kdsService.countKdsOrders as unknown as jest.Mock

function respuesta() {
  const res = { setHeader: jest.fn(), status: jest.fn(), json: jest.fn() }
  res.status.mockReturnValue(res)
  return res
}

async function llamar(query: Record<string, string> = {}) {
  const req = { params: { venueId: 'venue-1' }, query } as unknown as Request
  const res = respuesta()
  const next = jest.fn() as unknown as NextFunction
  await listKdsOrders(req, res as unknown as Response, next)
  return { res, next }
}

describe('listKdsOrders controller — total en X-Total-Count', () => {
  beforeEach(() => {
    listMock.mockReset()
    countMock.mockReset()
    ;(logger.warn as jest.Mock).mockClear()
  })

  it('manda el total real en el encabezado y avisa cuando el tope recortó', async () => {
    listMock.mockResolvedValue([{ id: 'a' }, { id: 'b' }])
    countMock.mockResolvedValue(3068)

    const { res } = await llamar()

    expect(res.setHeader).toHaveBeenCalledWith('X-Total-Count', '3068')
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('más comandas activas que el tope'),
      expect.objectContaining({ venueId: 'venue-1', total: 3068, devueltas: 2 }),
    )
  })

  it('el cuerpo conserva su forma: data sigue siendo el arreglo', async () => {
    listMock.mockResolvedValue([{ id: 'a' }])
    countMock.mockResolvedValue(1)

    const { res } = await llamar()

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ success: true, data: [{ id: 'a' }] })
  })

  it('sin recorte no avisa, y el filtro de estado llega igual a los dos', async () => {
    listMock.mockResolvedValue([{ id: 'a' }])
    countMock.mockResolvedValue(1)

    const { res } = await llamar({ status: 'COMPLETED' })

    expect(res.setHeader).toHaveBeenCalledWith('X-Total-Count', '1')
    expect(logger.warn).not.toHaveBeenCalled()
    expect(listMock).toHaveBeenCalledWith('venue-1', 'COMPLETED')
    expect(countMock).toHaveBeenCalledWith('venue-1', 'COMPLETED')
  })
})
