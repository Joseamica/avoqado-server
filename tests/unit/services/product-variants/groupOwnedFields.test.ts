import { prismaMock } from '@tests/__helpers__/setup'
import { assertNoGroupOwnedChanges, changedGroupOwnedFields } from '@/services/product-variants/groupOwnedFields'
import { createMenuCategory, updateMenuCategory } from '@/services/dashboard/menu.dashboard.service'

const actual = { name: 'Playera · M', categoryId: 'c1', taxRate: '0.16', ivaTratamiento: 'IVA_16', description: null, price: 10 }
describe('changedGroupOwnedFields', () => {
  it('un formulario que manda TODO con los mismos valores no cambia nada del padre', () => {
    expect(
      changedGroupOwnedFields(actual, {
        name: 'Playera · M',
        categoryId: 'c1',
        taxRate: 0.16,
        ivaTratamiento: 'IVA_16',
        description: null,
        price: 99,
      }),
    ).toEqual([])
  })
  it('detecta el cambio de nombre y categoría; el precio no es del padre', () => {
    expect(changedGroupOwnedFields(actual, { name: 'Otra', categoryId: 'c2', price: 1 })).toEqual(['name', 'categoryId'])
  })
  it('null y ausente no son lo mismo: ausente no cambia, null sí', () => {
    expect(changedGroupOwnedFields({ ...actual, description: 'x' }, {})).toEqual([])
    expect(changedGroupOwnedFields({ ...actual, description: 'x' }, { description: null })).toEqual(['description'])
  })
})

describe('assertNoGroupOwnedChanges — los extras de una variante son un CONJUNTO (ronda 1, N3)', () => {
  const db = () =>
    ({
      productModifierGroup: { findMany: jest.fn().mockResolvedValue([{ groupId: 'a' }, { groupId: 'b' }]) },
      productGroup: { findUnique: jest.fn().mockResolvedValue({ name: 'Camisa' }) },
    }) as any
  const variante = { id: 'p1', productGroupId: 'g1', name: 'Camisa · M' }

  it('los mismos extras en otro orden no son un cambio', async () => {
    await expect(assertNoGroupOwnedChanges(db(), variante, { modifierGroupIds: ['b', 'a'] })).resolves.toBeUndefined()
  })
  it('otro conjunto sí: 409 que dice dónde se edita', async () => {
    await expect(assertNoGroupOwnedChanges(db(), variante, { modifierGroupIds: ['a', 'c'] })).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/«Camisa»/),
    })
    await expect(assertNoGroupOwnedChanges(db(), variante, { modifierGroupIds: ['a'] })).rejects.toMatchObject({ statusCode: 409 })
  })
})

describe('categorías: la carrera con el agrupado responde 409, nunca 500 (ronda 1, menor)', () => {
  const choque = Object.assign(new Error('PostgresError { code: "P0001", message: "PRODUCT_GROUP_FIELD_OWNED_BY_PARENT" }'), {})
  beforeEach(() => {
    prismaMock.product.findFirst.mockResolvedValueOnce(null) // el pre-chequeo no vio variantes…
    prismaMock.product.updateMany.mockRejectedValueOnce(choque) // …y el trigger frenó la escritura
  })

  it('crear categoría', async () => {
    prismaMock.menuCategory.findUnique.mockResolvedValueOnce(null)
    prismaMock.menuCategory.create.mockResolvedValueOnce({ id: 'cat-1', name: 'Nueva' })
    await expect(createMenuCategory('v1', { name: 'Nueva', avoqadoProducts: [{ value: 'p1', label: 'x' }] } as any)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PRODUCT_FIELD_OWNED_BY_GROUP',
    })
  })
  it('editar categoría', async () => {
    prismaMock.menuCategory.findUnique.mockResolvedValueOnce({ id: 'cat-1', name: 'Vieja', active: true })
    await expect(updateMenuCategory('v1', 'cat-1', { avoqadoProducts: [{ value: 'p1', label: 'x' }] } as any)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PRODUCT_FIELD_OWNED_BY_GROUP',
    })
  })
})
