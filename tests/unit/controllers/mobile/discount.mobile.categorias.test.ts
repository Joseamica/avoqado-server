/**
 * D14 (Codex r1 #2, 5-nov-2026): la puerta de las apps (`/api/v1/mobile/venues/:venueId/discounts`) no pasa por Zod y creaba
 * descuentos «Categorías» sin categorías. iOS los manda así (sólo exige el nombre y omite la lista vacía); ANDROID apaga
 * «Guardar». iOS los lee como «todas las categorías» y el panel como «ninguna»: ahora se rechazan con 400 en español.
 */
import { Request, Response } from 'express'
import { prismaMock } from '../../../__helpers__/setup'
import { createDiscount, updateDiscount } from '../../../../src/controllers/mobile/discount.mobile.controller'

const SIN = 'Elige al menos una categoría para un descuento por categorías'
const respuesta = () => {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res as Response & { status: jest.Mock; json: jest.Mock }
}
const pedido = (body: any, params: any = { venueId: 'venue-1' }) =>
  ({ params, body, authContext: { staffVenueId: 'sv-1' } }) as unknown as Request
const guardado = (over: any = {}) =>
  ({ id: 'd1', venueId: 'venue-1', name: 'Pan', type: 'PERCENTAGE', value: 10, scope: 'ORDER', targetCategoryIds: [], ...over }) as any

describe('Descuentos desde las apps · «Categorías» sin categorías', () => {
  it('🔴 crear CATEGORY sin lista (como iOS): 400 en español, no se crea', async () => {
    const res = respuesta()
    await createDiscount(pedido({ name: 'Pan', type: 'PERCENTAGE', value: 10, scope: 'CATEGORY' }), res)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, message: SIN }))
    expect(prismaMock.discount.create).not.toHaveBeenCalled()
  })

  it('crear CATEGORY con lista vacía: 400', async () => {
    const res = respuesta()
    await createDiscount(pedido({ name: 'Pan', type: 'PERCENTAGE', value: 10, scope: 'CATEGORY', targetCategoryIds: [] }), res)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(prismaMock.discount.create).not.toHaveBeenCalled()
  })

  it('crear CATEGORY con una categoría (como ANDROID) sigue creando', async () => {
    prismaMock.discount.create.mockResolvedValue(
      guardado({
        scope: 'CATEGORY',
        targetCategoryIds: ['c1'],
        minPurchaseAmount: null,
        maxDiscountAmount: null,
        getDiscountPercent: null,
      }),
    )
    const res = respuesta()
    await createDiscount(pedido({ name: 'Pan', type: 'PERCENTAGE', value: 10, scope: 'CATEGORY', targetCategoryIds: ['c1'] }), res)
    expect(res.status).toHaveBeenCalledWith(201)
  })

  it('🔴 editar: vaciar la lista o pasar a CATEGORY sin categorías: 400, no se guarda', async () => {
    prismaMock.discount.findFirst.mockResolvedValue(guardado({ scope: 'CATEGORY', targetCategoryIds: ['c1'] }))
    const r1 = respuesta()
    await updateDiscount(pedido({ targetCategoryIds: [] }, { venueId: 'venue-1', discountId: 'd1' }), r1)
    expect(r1.status).toHaveBeenCalledWith(400)

    prismaMock.discount.findFirst.mockResolvedValue(guardado({ scope: 'ORDER', targetCategoryIds: [] }))
    const r2 = respuesta()
    await updateDiscount(pedido({ scope: 'CATEGORY' }, { venueId: 'venue-1', discountId: 'd1' }), r2)
    expect(r2.status).toHaveBeenCalledWith(400)
    expect(prismaMock.discount.update).not.toHaveBeenCalled()
  })
})
