import type { NextFunction, Request, Response } from 'express'

import { voidItems } from '@/controllers/tpv/order.tpv.controller'
import * as orderTpvService from '@/services/tpv/order.tpv.service'

/**
 * D2 (21-oct-2026, Codex r2 #2 y r3 #2): «Anular» todos los artículos de una venta de vales deja sus vales libres y lo anota en la
 * bitácora. El `staffId` llega en el CUERPO de la petición (cualquiera con `orders:void` puede mandar el de otro mesero); la bitácora la
 * firma quien está autenticado, así que el controlador pasa `authContext.userId` como `actorId`.
 */
describe('TPV «Anular»: quién firma la bitácora de los vales', () => {
  afterEach(() => jest.restoreAllMocks())

  it('pasa al usuario autenticado como actorId aunque el cuerpo traiga el staffId de otro mesero', async () => {
    const anular = jest.spyOn(orderTpvService, 'voidItems').mockResolvedValue({ id: 'o1' } as any)
    const req = {
      params: { venueId: 'v1', orderId: 'o1' },
      body: { itemIds: ['i1'], reason: 'el cliente se fue', staffId: 'otro-mesero', expectedVersion: 3 },
      authContext: { userId: 'autenticado' },
    } as unknown as Request<{ venueId: string; orderId: string }>
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response
    const next = jest.fn() as unknown as NextFunction

    await voidItems(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(anular).toHaveBeenCalledWith('v1', 'o1', expect.objectContaining({ staffId: 'otro-mesero', actorId: 'autenticado' }))
  })
})
