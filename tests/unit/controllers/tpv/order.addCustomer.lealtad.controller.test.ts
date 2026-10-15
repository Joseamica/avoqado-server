import type { NextFunction, Request, Response } from 'express'

const mockAdd = jest.fn()
const mockCreateAdd = jest.fn()
jest.mock('@/services/tpv/order.tpv.service', () => ({
  addCustomerToOrder: (...a: unknown[]) => mockAdd(...a),
  createAndAddCustomerToOrder: (...a: unknown[]) => mockCreateAdd(...a),
}))

import { addCustomerToOrder, createAndAddCustomerToOrder } from '@/controllers/tpv/order.tpv.controller'

function res() {
  const r: any = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn(() => r)
  return r as Response & { json: jest.Mock; status: jest.Mock }
}
/** Petición de la TPV con el actor en el token. */
function req(body: Record<string, unknown>): Request<any, any, any> {
  return { params: { venueId: 'v1', orderId: 'o1' }, body, authContext: { userId: 'staff-1' } } as unknown as Request<any, any, any>
}
const LISTA = [{ id: 'oc-1' }]
const SELLO = { stampsEnabled: true, stamped: true, reason: null, stampsEarned: 1, stampsRequired: 7, rewardReady: false }

describe('TPV — loyalty va HERMANO de data (data sigue siendo el arreglo que parsea la TPV publicada)', () => {
  it('orders/:orderId/customers', async () => {
    mockAdd.mockResolvedValue({ orderCustomers: LISTA, loyalty: SELLO })
    const r = res()
    await addCustomerToOrder(req({ customerId: 'c1' }), r, jest.fn() as NextFunction)
    // 5.º argumento: ¿quien liga tiene payments:create? (MEDIO-1). Aquí la base de prueba no tiene su rol ⇒ falla cerrado.
    // El permiso real (KITCHEN, CASHIER, override del negocio) lo prueba `order.addCustomer.permisoDeCobro.test.ts`.
    expect(mockAdd).toHaveBeenCalledWith('v1', 'o1', 'c1', 'staff-1', { otorgarLealtad: false })
    expect(r.status).toHaveBeenCalledWith(201)
    expect(r.json).toHaveBeenCalledWith({ success: true, data: LISTA, loyalty: SELLO, message: 'Customer added to order successfully' })
    // `data` es el ARREGLO de siempre: la TPV publicada lo parsea como lista (OrderCustomerDto).
    expect(Array.isArray(r.json.mock.calls[0][0].data)).toBe(true)
  })

  it('orders/:orderId/customers/create', async () => {
    mockCreateAdd.mockResolvedValue({ orderCustomers: LISTA, loyalty: null })
    const r = res()
    await createAndAddCustomerToOrder(req({ firstName: 'Dany' }), r, jest.fn() as NextFunction)
    expect(mockCreateAdd).toHaveBeenCalledWith('v1', 'o1', { firstName: 'Dany', phone: undefined, email: undefined }, 'staff-1', {
      otorgarLealtad: false,
    })
    expect(r.status).toHaveBeenCalledWith(201)
    expect(r.json).toHaveBeenCalledWith({
      success: true,
      data: LISTA,
      loyalty: null,
      message: 'Customer created and added to order successfully',
    })
  })

  it('un error del servicio va a next, nunca un 201', async () => {
    const error = new Error('Customer already added to this order')
    mockAdd.mockRejectedValue(error)
    const r = res()
    const next = jest.fn()
    await addCustomerToOrder(req({ customerId: 'c1' }), r, next as NextFunction)
    expect(next).toHaveBeenCalledWith(error)
    expect(r.json).not.toHaveBeenCalled()
  })
})
