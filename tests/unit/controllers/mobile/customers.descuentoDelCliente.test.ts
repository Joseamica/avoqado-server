import { getCustomers as getCustomersMobile } from '@/controllers/mobile/customer.mobile.controller'
import { getCustomers as getCustomersDashboard } from '@/controllers/dashboard/customer.dashboard.controller'
import * as customerService from '@/services/dashboard/customer.dashboard.service'
import { descuentosDeLosClientes } from '@/services/shared/descuentoDelCliente.service'
import logger from '@/config/logger'

jest.mock('@/services/dashboard/customer.dashboard.service')
jest.mock('@/services/shared/descuentoDelCliente.service')
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

const descuento = { discountId: 'cd1', name: 'Socio', type: 'PERCENTAGE', value: 10, maxDiscountAmount: null }
const pagina = () => ({
  data: [
    { id: 'c1', firstName: 'Ana' },
    { id: 'c2', firstName: 'Beto' },
  ],
  meta: { totalCount: 2, pageSize: 20 },
})

function llamar(fn: typeof getCustomersMobile) {
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
  const next = jest.fn()
  return fn({ params: { venueId: 'v1' }, query: { limit: '50' } } as any, res, next).then(() => ({ res, next }))
}

describe('GET /mobile/venues/:venueId/customers — descuentoDelCliente', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(customerService.getCustomers as jest.Mock).mockResolvedValue(pagina())
  })

  it('1a: trae el descuento de quien lo tiene y null en el otro, con UNA consulta', async () => {
    ;(descuentosDeLosClientes as jest.Mock).mockResolvedValue(new Map([['c1', descuento]]))
    const { res } = await llamar(getCustomersMobile)
    expect(descuentosDeLosClientes).toHaveBeenCalledTimes(1)
    expect(descuentosDeLosClientes).toHaveBeenCalledWith('v1', ['c1', 'c2'])
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({
      data: [
        { id: 'c1', firstName: 'Ana', descuentoDelCliente: descuento },
        { id: 'c2', firstName: 'Beto', descuentoDelCliente: null },
      ],
      meta: { totalCount: 2, pageSize: 20 },
    })
  })

  it('1b: si la consulta falla responde 200 con todos en null y un warn', async () => {
    ;(descuentosDeLosClientes as jest.Mock).mockRejectedValue(new Error('boom'))
    const { res, next } = await llamar(getCustomersMobile)
    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json.mock.calls[0][0].data.map((c: any) => c.descuentoDelCliente)).toEqual([null, null])
    expect(logger.warn).toHaveBeenCalled()
  })

  it('1c: el controlador del DASHBOARD no cambia (sin el campo)', async () => {
    const { res } = await llamar(getCustomersDashboard)
    expect(descuentosDeLosClientes).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(pagina())
  })
})
