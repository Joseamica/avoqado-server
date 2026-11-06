/**
 * D14 (Codex r4 #2, 5-nov-2026): ANDROID manda los usos de un cupón tal como se escriben; un 0 dejaba el cupón agotado desde
 * el principio. Al crear, 0 y negativos son 400 en español; al editar, sólo si el valor cambia (un 0 viejo que ANDROID
 * reenvía al editar otra cosa pasa). ANDROID todavía enseña su texto genérico «No se pudo guardar» (tarjeta aparte).
 */
import { Request, Response } from 'express'
import { prismaMock } from '../../../__helpers__/setup'
import { createCoupon, updateCoupon } from '../../../../src/controllers/mobile/coupon.mobile.controller'

const LIM = 'Los límites de uso van de 1 en adelante; déjalo vacío para que sea ilimitado'
const respuesta = () => {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res as Response & { status: jest.Mock; json: jest.Mock }
}
const pedido = (body: any, params: any) => ({ params, body }) as unknown as Request

describe('Cupones desde las apps · límites de uso', () => {
  it('🔴 crear con 0 usos: 400 en español, no se crea', async () => {
    prismaMock.discount.findFirst.mockResolvedValue({ id: 'd1', venueId: 'v1' } as any)
    prismaMock.couponCode.findUnique.mockResolvedValue(null)
    const res = respuesta()
    await createCoupon(pedido({ discountId: 'd1', code: 'PAN10', maxUses: 0 }, { venueId: 'v1' }), res)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: LIM }))
    expect(prismaMock.couponCode.create).not.toHaveBeenCalled()
  })

  it('editar: cambiar a -1 es 400; reenviar el 0 viejo pasa', async () => {
    prismaMock.couponCode.findFirst.mockResolvedValue({ id: 'c1', code: 'PAN10', maxUses: 0, maxUsesPerCustomer: null } as any)
    const r1 = respuesta()
    await updateCoupon(pedido({ maxUsesPerCustomer: -1 }, { venueId: 'v1', couponId: 'c1' }), r1)
    expect(r1.status).toHaveBeenCalledWith(400)
    expect(prismaMock.couponCode.update).not.toHaveBeenCalled()

    prismaMock.couponCode.update.mockResolvedValue({ id: 'c1', code: 'PAN10', maxUses: 0, minPurchaseAmount: null } as any)
    const r2 = respuesta()
    await updateCoupon(pedido({ maxUses: 0, active: false }, { venueId: 'v1', couponId: 'c1' }), r2)
    expect(r2.status).not.toHaveBeenCalledWith(400)
    expect(prismaMock.couponCode.update).toHaveBeenCalled()
  })
})
