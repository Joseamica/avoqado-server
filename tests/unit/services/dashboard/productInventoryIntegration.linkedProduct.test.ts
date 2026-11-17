/**
 * Extra ligado a un PLATILLO del menú (encargo 27771e; founder, 16-nov-2026: como Fudo y Toast).
 *
 * Al venderse el extra «Papas» ligado al platillo «Papas a la francesa», se descuenta 1 porción de ese platillo por selección
 * (× la cantidad del renglón): sus piezas o su receta completa, con la MISMA línea del vale y la misma cerca que el renglón. El
 * platillo ligado se descuenta SIN extras (nunca hay recursión) y sólo si es del mismo negocio.
 */

import { Decimal } from '@prisma/client/runtime/library'
import { prismaMock } from '../../../__helpers__/setup'
import { deductInventoryForProduct } from '../../../../src/services/dashboard/productInventoryIntegration.service'
import { deductStockForModifiers, deductStockForRecipe } from '../../../../src/services/dashboard/rawMaterial.service'

jest.mock('../../../../src/services/dashboard/rawMaterial.service', () => {
  const actual = jest.requireActual('../../../../src/services/dashboard/rawMaterial.service')
  return { ...actual, deductStockForRecipe: jest.fn(), deductStockForModifiers: jest.fn() }
})

const VENUE_ID = 'venue-1'
const ORDER_ID = 'order-1'
const BURGER_ID = 'product-burger'
const PAPAS_ID = 'product-papas'
const AROS_ID = 'product-aros'
const options = { postingLineId: 'line-1', fence: { postingId: 'posting-1', claimStamp: new Date('2026-11-16T12:00:00Z') } }

const extra = (overrides: Record<string, any> = {}, quantity = 1) => ({
  quantity,
  modifier: {
    id: 'mod-papas',
    name: 'Papas',
    groupId: 'g1',
    rawMaterialId: null,
    quantityPerUnit: null,
    unit: null,
    inventoryMode: 'ADDITION' as any,
    linkedProductId: PAPAS_ID,
    ...overrides,
  },
})

const productos: Record<string, any> = {
  [BURGER_ID]: { id: BURGER_ID, venueId: VENUE_ID, name: 'Hamburguesa', trackInventory: false, inventoryMethod: null, soldByWeight: false },
  [PAPAS_ID]: {
    id: PAPAS_ID,
    venueId: VENUE_ID,
    name: 'Papas a la francesa',
    trackInventory: true,
    inventoryMethod: 'QUANTITY',
    soldByWeight: false,
  },
  [AROS_ID]: {
    id: AROS_ID,
    venueId: VENUE_ID,
    name: 'Aros de cebolla',
    trackInventory: true,
    inventoryMethod: 'RECIPE',
    soldByWeight: false,
    recipe: { id: 'r-aros' },
  },
}

/** El findUnique/findFirst del producto contesta según el id (y el negocio, si lo piden). */
function mockCatalogo(overrides: Record<string, any> = {}) {
  const catalogo = { ...productos, ...overrides }
  const leer = (args: any) => {
    const p = catalogo[args?.where?.id]
    if (!p) return Promise.resolve(null)
    if (args?.where?.venueId && args.where.venueId !== p.venueId) return Promise.resolve(null)
    return Promise.resolve(p)
  }
  prismaMock.product.findUnique.mockImplementation(leer as any)
  prismaMock.product.findFirst.mockImplementation(leer as any)
  prismaMock.product.findMany.mockImplementation(((args: any) =>
    Promise.all((args?.where?.id?.in ?? []).map((id: string) => leer({ where: { id, venueId: args.where.venueId } }))).then(r =>
      r.filter(Boolean),
    )) as any)
}

/** El UPDATE atómico de Inventory de deductSimpleStock (dentro de su transacción). */
function mockStockPorPiezas(antes = 10) {
  let stock = antes
  prismaMock.$queryRaw.mockImplementation((async (strings: any, ...values: any[]) => {
    // La cerca del vale (postingFence) lee el sello del reclamo: es el nuestro.
    if (String(strings?.join?.('') ?? '').includes('InventoryPosting')) return [{ updatedAt: options.fence.claimStamp }]
    const qty = Number(values[0])
    stock -= qty
    return [{ id: 'inv-papas', currentStock: new Decimal(stock), previousStock: new Decimal(stock + qty) }]
  }) as any)
  prismaMock.inventoryMovement.create.mockResolvedValue({} as any)
}

describe('deductInventoryForProduct — extra ligado a un platillo del menú', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCatalogo()
    mockStockPorPiezas(10)
  })

  it('platillo principal SIN inventario + 2× «Papas» (por piezas): baja 2 piezas de papas, con la línea del vale', async () => {
    await deductInventoryForProduct(VENUE_ID, BURGER_ID, 1, ORDER_ID, 'staff-1', [extra({}, 2)] as any, options)

    expect(prismaMock.inventoryMovement.create).toHaveBeenCalledTimes(1)
    const mov = (prismaMock.inventoryMovement.create.mock.calls[0][0] as any).data
    expect(mov.quantity.toString()).toBe('-2')
    expect(mov.postingLineId).toBe('line-1')
    expect(mov.reference).toBe(ORDER_ID)
  })

  it('la cantidad del renglón multiplica: 3 hamburguesas con 1× «Papas» bajan 3 piezas', async () => {
    await deductInventoryForProduct(VENUE_ID, BURGER_ID, 3, ORDER_ID, 'staff-1', [extra()] as any, options)
    const mov = (prismaMock.inventoryMovement.create.mock.calls[0][0] as any).data
    expect(mov.quantity.toString()).toBe('-3')
  })

  it('platillo ligado por RECETA: descuenta su receta completa, sin extras y con la misma línea y cerca', async () => {
    await deductInventoryForProduct(VENUE_ID, BURGER_ID, 1, ORDER_ID, 'staff-1', [extra({ linkedProductId: AROS_ID }, 2)] as any, options)

    expect(deductStockForRecipe).toHaveBeenCalledWith(VENUE_ID, AROS_ID, 2, ORDER_ID, 'staff-1', undefined, 'line-1', options.fence)
  })

  it('platillo principal por RECETA: descuenta su receta Y la del ligado, y los extras de insumo siguen igual (regresión)', async () => {
    mockCatalogo({ [BURGER_ID]: { ...productos[BURGER_ID], trackInventory: true, inventoryMethod: 'RECIPE', recipe: { id: 'r-b' } } })
    const insumo = {
      quantity: 1,
      modifier: {
        id: 'mod-queso',
        name: 'Queso',
        groupId: 'g1',
        rawMaterialId: 'rm-queso',
        quantityPerUnit: new Decimal(30),
        unit: 'GRAM',
        inventoryMode: 'ADDITION',
        linkedProductId: null,
      },
    }
    const mods = [insumo, extra({ linkedProductId: AROS_ID })]
    await deductInventoryForProduct(VENUE_ID, BURGER_ID, 1, ORDER_ID, 'staff-1', mods as any, options)

    expect(deductStockForRecipe).toHaveBeenCalledWith(VENUE_ID, BURGER_ID, 1, ORDER_ID, 'staff-1', mods, 'line-1', options.fence)
    expect(deductStockForModifiers).toHaveBeenCalledWith(VENUE_ID, 1, mods, ORDER_ID, 'staff-1', 'line-1', options.fence)
    expect(deductStockForRecipe).toHaveBeenCalledWith(VENUE_ID, AROS_ID, 1, ORDER_ID, 'staff-1', undefined, 'line-1', options.fence)
  })

  it('platillo principal por PIEZAS: baja el suyo y el del ligado', async () => {
    mockCatalogo({ [BURGER_ID]: { ...productos[BURGER_ID], trackInventory: true, inventoryMethod: 'QUANTITY' } })
    await deductInventoryForProduct(VENUE_ID, BURGER_ID, 1, ORDER_ID, 'staff-1', [extra()] as any, options)
    expect(prismaMock.inventoryMovement.create).toHaveBeenCalledTimes(2)
  })

  it('platillo principal pesado (2.5 kg): el extra ligado es por renglón → 1 porción, no 2.5', async () => {
    mockCatalogo({ [BURGER_ID]: { ...productos[BURGER_ID], soldByWeight: true } })
    await deductInventoryForProduct(VENUE_ID, BURGER_ID, 2.5, ORDER_ID, 'staff-1', [extra()] as any, options)
    const mov = (prismaMock.inventoryMovement.create.mock.calls[0][0] as any).data
    expect(mov.quantity.toString()).toBe('-1')
  })

  it('un ligado de OTRO negocio no se descuenta (aislamiento por negocio)', async () => {
    mockCatalogo({ [PAPAS_ID]: { ...productos[PAPAS_ID], venueId: 'otro-venue' } })
    await deductInventoryForProduct(VENUE_ID, BURGER_ID, 1, ORDER_ID, 'staff-1', [extra()] as any, options)
    expect(prismaMock.inventoryMovement.create).not.toHaveBeenCalled()
    expect(deductStockForRecipe).not.toHaveBeenCalled()
  })

  it('un ligado borrado de la base no se inventa (sin descuento, sin error)', async () => {
    mockCatalogo({ [PAPAS_ID]: undefined })
    await expect(deductInventoryForProduct(VENUE_ID, BURGER_ID, 1, ORDER_ID, 'staff-1', [extra()] as any, options)).resolves.toBeDefined()
    expect(prismaMock.inventoryMovement.create).not.toHaveBeenCalled()
  })

  it('un ligado que ahora se vende por kilo no descuenta 1 kg a ciegas', async () => {
    mockCatalogo({ [PAPAS_ID]: { ...productos[PAPAS_ID], soldByWeight: true } })
    await deductInventoryForProduct(VENUE_ID, BURGER_ID, 1, ORDER_ID, 'staff-1', [extra()] as any, options)
    expect(prismaMock.inventoryMovement.create).not.toHaveBeenCalled()
  })

  it('un ligado SIN inventario no descuenta nada (el dueño todavía no le prende el inventario)', async () => {
    mockCatalogo({ [PAPAS_ID]: { ...productos[PAPAS_ID], trackInventory: false, inventoryMethod: null } })
    await deductInventoryForProduct(VENUE_ID, BURGER_ID, 1, ORDER_ID, 'staff-1', [extra()] as any, options)
    expect(prismaMock.inventoryMovement.create).not.toHaveBeenCalled()
    expect(deductStockForRecipe).not.toHaveBeenCalled()
  })

  it('el extra ligado al MISMO platillo que lo lleva descuenta una porción más, sin recursión', async () => {
    mockCatalogo({ [PAPAS_ID]: productos[PAPAS_ID] })
    await deductInventoryForProduct(VENUE_ID, PAPAS_ID, 1, ORDER_ID, 'staff-1', [extra()] as any, options)
    expect(prismaMock.inventoryMovement.create).toHaveBeenCalledTimes(2)
  })

  it('Codex r2 #6: dos extras ligados al MISMO platillo se leen en UNA consulta y se descuentan en una pasada', async () => {
    const otro = extra({ id: 'mod-papas-2', name: 'Papas extra' }, 3)
    await deductInventoryForProduct(VENUE_ID, BURGER_ID, 1, ORDER_ID, 'staff-1', [extra({}, 2), otro] as any, options)
    expect(prismaMock.product.findMany).toHaveBeenCalledTimes(1)
    expect((prismaMock.product.findMany.mock.calls[0][0] as any).where).toEqual({ id: { in: [PAPAS_ID] }, venueId: VENUE_ID })
    expect(prismaMock.inventoryMovement.create).toHaveBeenCalledTimes(1)
    expect((prismaMock.inventoryMovement.create.mock.calls[0][0] as any).data.quantity.toString()).toBe('-5')
  })

  it('regresión: sin extras ligados no se consulta ningún platillo de más', async () => {
    const insumo = {
      quantity: 1,
      modifier: {
        id: 'mod-queso',
        name: 'Queso',
        groupId: 'g1',
        rawMaterialId: 'rm-queso',
        quantityPerUnit: new Decimal(30),
        unit: 'GRAM',
        inventoryMode: 'ADDITION',
      },
    }
    await deductInventoryForProduct(VENUE_ID, BURGER_ID, 1, ORDER_ID, 'staff-1', [insumo] as any, options)
    expect(prismaMock.product.findMany).not.toHaveBeenCalled()
    expect(prismaMock.inventoryMovement.create).not.toHaveBeenCalled()
    expect(deductStockForModifiers).toHaveBeenCalledTimes(1)
  })
})
