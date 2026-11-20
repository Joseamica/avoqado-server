/**
 * D7 «Anular producto», decisión 1 = A acotada (founder por delegación, 20-nov-2026): la ronda CON RED de Mesas
 * (`POST /mobile/venues/:venueId/orders/:orderId/items`) también lleva la llave de su ronda (`sync:<ronda>:<n>`). Las apps mandan la
 * misma en línea y en la cola: pasa intacta. Otra forma se reemplaza; sin ninguna llave de Avoqado, la ronda toma una nueva.
 */
import type { NextFunction, Request, Response } from 'express'

import { addItemsToOrder } from '@/controllers/mobile/order.mobile.controller'
import * as orderTpvService from '@/services/tpv/order.tpv.service'

jest.mock('@/services/tpv/order.tpv.service', () => ({ addItemsToOrder: jest.fn() }))
jest.mock('@/services/mobile/service-charge.mobile.service', () => ({ syncAutomaticServiceCharges: jest.fn() }))

const addItemsMock = orderTpvService.addItemsToOrder as jest.Mock

function res() {
  const r = {} as Response
  r.status = jest.fn().mockReturnValue(r) as unknown as Response['status']
  r.json = jest.fn().mockReturnValue(r) as unknown as Response['json']
  return r
}

const req = (items: unknown[]) =>
  ({ params: { venueId: 'venue-1', orderId: 'order-1' }, body: { items, version: 3 }, authContext: { userId: 's' } }) as unknown as Request

describe('ronda con red: la llave de la ronda (decisión 1 de D7)', () => {
  const next = jest.fn() as NextFunction
  beforeEach(() => {
    jest.clearAllMocks()
    addItemsMock.mockResolvedValue({ id: 'order-1', version: 4 })
  })

  it('la de las apps pasa intacta; las demás toman la ronda de la primera y su posición', async () => {
    await addItemsToOrder(
      req([
        { productId: 'p', quantity: 1, externalId: 'sync:abc:0' },
        { productId: 'p', quantity: 1, externalId: ' cafe-1 ' },
        { productId: 'p', quantity: 1, externalId: 'sync:otra:0' },
      ]),
      res(),
      next,
    )
    expect(next).not.toHaveBeenCalled()
    expect(addItemsMock.mock.calls[0][2].map((it: any) => it.externalId)).toEqual(['sync:abc:0', 'sync:abc:1', 'sync:abc:2'])
    expect(addItemsMock.mock.calls[0].slice(3)).toEqual([3, true])
  })

  it('sin ninguna llave de Avoqado: una ronda nueva, con la misma forma', async () => {
    await addItemsToOrder(
      req([
        { productId: 'p', quantity: 1, externalId: ' ' },
        { productId: 'p', quantity: 1 },
      ]),
      res(),
      next,
    )
    const llaves = addItemsMock.mock.calls[0][2].map((it: any) => it.externalId)
    expect(llaves[0]).toMatch(/^sync:[0-9a-f-]{36}:0$/)
    expect(llaves[1]).toBe(llaves[0].replace(/:0$/, ':1'))
  })
})
