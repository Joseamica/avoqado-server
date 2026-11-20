/**
 * «Eliminar» categoría desde la app (ANDROID «Artículos → Categorías», iOS) · encargo bc1dcc (19-nov-2026).
 * Con productos o subcategorías vivas, el contrato de siempre: sólo se apaga y contesta 200 (la app publicada no lee el porqué de
 * un 400 y enseñaría «Error al eliminar»). Sin nada vivo, la regla del panel: se borra o queda eliminada (escondida).
 */
import { prismaMock } from '@tests/__helpers__/setup'

const deleteMenuCategory = jest.fn()
jest.mock('@/services/dashboard/menu.dashboard.service', () => ({ deleteMenuCategory: (...a: unknown[]) => deleteMenuCategory(...a) }))

import { deleteCategory } from '@/controllers/mobile/category.mobile.controller'
import { BadRequestError } from '@/errors/AppError'

const V = 'venue-1'
const C = 'cat-1'
function respuesta() {
  const res: any = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  return res
}
const req = { params: { venueId: V, categoryId: C } } as any

beforeEach(() => {
  jest.clearAllMocks()
  deleteMenuCategory.mockReset()
  prismaMock.menuCategory.findFirst.mockResolvedValue({ id: C } as never)
  prismaMock.product.count.mockResolvedValue(0 as never)
  prismaMock.menuCategory.count.mockResolvedValue(0 as never)
  prismaMock.menuCategory.updateMany.mockResolvedValue({ count: 1 } as never)
})

describe('DELETE /mobile/.../categories/:id', () => {
  it('REGRESIÓN: con productos vivos sólo la apaga (200) y no pasa por la regla del panel', async () => {
    prismaMock.product.count.mockResolvedValue(3 as never)
    const res = respuesta()
    await deleteCategory(req, res, jest.fn())

    expect(res.json).toHaveBeenCalledWith({ success: true, data: { id: C } })
    expect(prismaMock.menuCategory.updateMany).toHaveBeenCalledWith({
      where: { id: C, venueId: V, active: true, deletedAt: null },
      data: { active: false },
    })
    expect(deleteMenuCategory).not.toHaveBeenCalled()
  })

  it('REGRESIÓN: con una subcategoría visible también sólo la apaga (200)', async () => {
    prismaMock.menuCategory.count.mockResolvedValue(1 as never)
    const res = respuesta()
    await deleteCategory(req, res, jest.fn())

    expect(res.json).toHaveBeenCalledWith({ success: true, data: { id: C } })
    expect(deleteMenuCategory).not.toHaveBeenCalled()
  })

  it('REGRESIÓN: una ya apagada con productos da 404, como antes', async () => {
    prismaMock.product.count.mockResolvedValue(3 as never)
    prismaMock.menuCategory.updateMany.mockResolvedValue({ count: 0 } as never)
    const res = respuesta()
    await deleteCategory(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(404)
  })

  it('sin nada vivo usa la regla del panel (se borra o queda escondida) y contesta 200', async () => {
    deleteMenuCategory.mockResolvedValue({ id: C })
    const res = respuesta()
    await deleteCategory(req, res, jest.fn())

    expect(deleteMenuCategory).toHaveBeenCalledWith(V, C)
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { id: C } })
  })

  it('si en medio le entró un producto (el panel la rechaza), se apaga como siempre: 200, nunca un error', async () => {
    deleteMenuCategory.mockRejectedValue(new BadRequestError('No se puede eliminar', 'CATEGORY_HAS_PRODUCTS'))
    const res = respuesta()
    const next = jest.fn()
    await deleteCategory(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { id: C } })
    expect(prismaMock.menuCategory.updateMany).toHaveBeenCalledWith({
      where: { id: C, venueId: V, active: true, deletedAt: null },
      data: { active: false },
    })
  })

  it('una eliminada (o de otro negocio) da 404', async () => {
    prismaMock.menuCategory.findFirst.mockResolvedValue(null as never)
    const res = respuesta()
    await deleteCategory(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(404)
    expect(prismaMock.menuCategory.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: C, venueId: V, deletedAt: null } }),
    )
  })
})
