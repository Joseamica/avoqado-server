/**
 * hz:e82938e1:D36: la ruta que usa la TPV al regresar sin cobrar en «Cobrar». El staff y la terminal salen del TOKEN, nunca del
 * cuerpo; un rechazo viaja al manejador de errores con su `code`, para que la terminal sepa que es definitivo.
 */
import { BadRequestError } from '@/errors/AppError'

const anularMock = jest.fn()
jest.mock('@/services/tpv/ventaDeCobrarSinCobro.tpv.service', () => ({
  ...jest.requireActual('@/services/tpv/ventaDeCobrarSinCobro.tpv.service'),
  anularVentaDeCobrarSinCobro: (...a: unknown[]) => anularMock(...a),
}))

import { retirarVentaSinCobro } from '@/controllers/tpv/order.tpv.controller'

const mockRes = () => {
  const r: any = {}
  r.status = jest.fn().mockReturnValue(r)
  r.json = jest.fn().mockReturnValue(r)
  return r
}
const req = (body: any = {}) =>
  ({
    params: { venueId: 'venue-1', orderId: 'order-1' },
    body,
    authContext: { userId: 'staff-del-token', terminalSerialNumber: 'AVQD-2841548417' },
  }) as any

beforeEach(() => jest.clearAllMocks())

describe('order.tpv.controller — retirarVentaSinCobro (D36)', () => {
  it('delega con el staff y la terminal del TOKEN (el cuerpo se ignora) y contesta 200 con el estado', async () => {
    anularMock.mockResolvedValue({ estado: 'RETIRADA' })
    const res = mockRes()
    const next = jest.fn()

    await retirarVentaSinCobro(req({ staffId: 'atacante', terminalSerial: 'OTRA' }), res, next)

    expect(anularMock).toHaveBeenCalledWith('venue-1', 'order-1', { staffId: 'staff-del-token', terminalSerial: 'AVQD-2841548417' })
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { estado: 'RETIRADA' } })
    expect(next).not.toHaveBeenCalled()
  })

  it('un rechazo pasa al manejador de errores con su code (la terminal no reintenta un 4xx)', async () => {
    const rechazo = new BadRequestError('No es una venta de Cobrar', 'NO_ES_VENTA_DE_COBRAR')
    anularMock.mockRejectedValue(rechazo)
    const res = mockRes()
    const next = jest.fn()

    await retirarVentaSinCobro(req(), res, next)

    expect(next).toHaveBeenCalledWith(rechazo)
    expect(res.status).not.toHaveBeenCalled()
  })
})
