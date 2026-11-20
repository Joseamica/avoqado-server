/**
 * D36: la ruta que usa la TPV al tocar «atrás» antes de cobrar en «Cobrar». El staff sale del token, nunca del cuerpo, y un rechazo
 * viaja con su `code` y su `motivo` para que la TPV sepa que es definitivo.
 */
import { ConflictError } from '@/errors/AppError'
import * as controller from '@/controllers/tpv/order-table.tpv.controller'
import * as servicio from '@/services/tpv/retirarVentaSinCobro.service'

jest.mock('@/services/tpv/retirarVentaSinCobro.service', () => ({
  ...jest.requireActual('@/services/tpv/retirarVentaSinCobro.service'),
  retirarVentaSinCobro: jest.fn(),
}))
jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))

const retirarMock = servicio.retirarVentaSinCobro as jest.Mock

const mockRes = () => {
  const r: any = {}
  r.status = jest.fn().mockReturnValue(r)
  r.json = jest.fn().mockReturnValue(r)
  return r
}
const req = (body: any = {}) =>
  ({ params: { venueId: 'venue-1', orderId: 'order-1' }, body, authContext: { userId: 'staff-del-token' } }) as any

beforeEach(() => jest.clearAllMocks())

describe('order-table.tpv.controller — retirarVentaSinCobro (D36)', () => {
  it('delega con el staff del TOKEN (el del cuerpo se ignora) y contesta 200 con el estado', async () => {
    retirarMock.mockResolvedValue({ estado: 'RETIRADA' })
    const res = mockRes()

    await controller.retirarVentaSinCobro(req({ staffId: 'atacante' }), res)

    expect(retirarMock).toHaveBeenCalledWith('venue-1', 'order-1', 'staff-del-token')
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { estado: 'RETIRADA' } })
  })

  it('un rechazo sale 409 con code VENTA_NO_RETIRABLE y su motivo', async () => {
    retirarMock.mockRejectedValue(
      new ConflictError('Esta venta ya tuvo un intento de cobro', 'VENTA_NO_RETIRABLE', { motivo: 'CON_INTENTO_DE_COBRO' }),
    )
    const res = mockRes()

    await controller.retirarVentaSinCobro(req(), res)

    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Esta venta ya tuvo un intento de cobro',
      code: 'VENTA_NO_RETIRABLE',
      details: { motivo: 'CON_INTENTO_DE_COBRO' },
    })
  })
})
