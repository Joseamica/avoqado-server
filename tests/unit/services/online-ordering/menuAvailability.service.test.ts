import { prismaMock } from '@tests/__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'
import { clearPublicMenuCache } from '@/services/online-ordering/menu.service'
import { setOnlineAvailability } from '@/services/online-ordering/menuAvailability.service'

describe('setOnlineAvailability', () => {
  beforeEach(() => prismaMock.product.updateMany.mockResolvedValue({ count: 3 }))

  it('por ids y categorías, siempre dentro del venue y sin tocar borrados', async () => {
    const r = await setOnlineAvailability({
      venueId: 'v1',
      availableOnline: true,
      productIds: ['p1', 'p2'],
      categoryIds: ['c1'],
      actorStaffId: 'staff1',
    })
    expect(r).toEqual({ updated: 3 })
    const call = prismaMock.product.updateMany.mock.calls[0][0] as any
    expect(call.where).toMatchObject({ venueId: 'v1', deletedAt: null })
    expect(call.where.OR).toEqual([{ id: { in: ['p1', 'p2'] } }, { categoryId: { in: ['c1'] } }])
    expect(call.data).toEqual({ availableOnline: true })
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'ONLINE_MENU_AVAILABILITY_UPDATED', venueId: 'v1' }))
  })

  it('«todo el menú» no lleva filtro de ids', async () => {
    await setOnlineAvailability({ venueId: 'v1', availableOnline: true, allProducts: true, actorStaffId: null })
    const call = prismaMock.product.updateMany.mock.calls[0][0] as any
    expect(call.where.OR).toBeUndefined()
  })

  it('sin ids, categorías ni «todo» es un error', async () => {
    await expect(setOnlineAvailability({ venueId: 'v1', availableOnline: true, actorStaffId: null })).rejects.toMatchObject({
      statusCode: 400,
    })
    expect(prismaMock.product.updateMany).not.toHaveBeenCalled()
  })

  it('invalida la caché de la carta pública', async () => {
    const spy = jest.spyOn(require('@/services/online-ordering/menu.service'), 'clearPublicMenuCache')
    await setOnlineAvailability({ venueId: 'v1', availableOnline: false, productIds: ['p1'], actorStaffId: null })
    expect(spy).toHaveBeenCalled()
    clearPublicMenuCache()
  })
})
