import type { NextFunction, Request, Response } from 'express'

import { createOrderWithItems } from '@/controllers/tpv/order.tpv.controller'
import * as permisos from '@/middlewares/permissionFlag.middleware'
import * as orderTpvService from '@/services/tpv/order.tpv.service'
import * as discountTpvService from '@/services/tpv/discount.tpv.service'

/**
 * hz:e0b12f00:D1 (Codex r2 #1 y r3 #1): en «Cobrar», un descuento libre que deja la cuenta en $0 queda autorizado por quien COBRA
 * (su membresía) o por el gerente del PIN; nunca por el vendedor del cuerpo. También cuando el permiso de cortesía ya se había
 * revisado por otra razón (un descuento de artículo activa `canCompItems` sin pasar por el PIN).
 */
describe('TPV «Cobrar»: quién autoriza el descuento que deja la cuenta en $0', () => {
  afterEach(() => jest.restoreAllMocks())

  const llamar = async (body: Record<string, unknown>) => {
    const crear = jest.spyOn(orderTpvService, 'createOrderWithItems').mockResolvedValue({ id: 'o1' } as any)
    const req = {
      params: { venueId: 'v1' },
      body: { staffId: 'vendedor', items: [{ productId: 'p1', quantity: 1, itemDiscountId: 'art10' }], ...body },
      authContext: { userId: 'quien-cobra' },
    } as unknown as Request<{ venueId: string }>
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response
    const next = jest.fn() as unknown as NextFunction
    await createOrderWithItems(req, res, next)
    expect(next).not.toHaveBeenCalled()
    return crear
  }

  it('con permiso de cortesía revisado por el descuento de artículo: autoriza la membresía de quien cobra', async () => {
    jest.spyOn(permisos, 'tienePermisoEnVenue').mockResolvedValue(true)
    const membresia = jest.spyOn(discountTpvService, 'membresiaDeQuienLlama').mockResolvedValue('sv-quien-cobra')
    const crear = await llamar({ discount: 90 })
    expect(membresia).toHaveBeenCalledWith('v1', 'quien-cobra')
    expect(crear).toHaveBeenCalledWith('v1', expect.objectContaining({ canCompItems: true, regaloAutorizadoPor: 'sv-quien-cobra' }))
  })

  it('sin permiso de cortesía: no resuelve autorizador', async () => {
    jest.spyOn(permisos, 'tienePermisoEnVenue').mockResolvedValue(false)
    const membresia = jest.spyOn(discountTpvService, 'membresiaDeQuienLlama')
    const crear = await llamar({ discount: 10 })
    expect(membresia).not.toHaveBeenCalled()
    expect(crear).toHaveBeenCalledWith('v1', expect.objectContaining({ canCompItems: false, regaloAutorizadoPor: undefined }))
  })
})
