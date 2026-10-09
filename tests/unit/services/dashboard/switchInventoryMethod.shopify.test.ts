/**
 * `switchInventoryMethod` es compartido (dashboard, POS, MCP). Para un producto SIN pareja de Shopify el cambio a receta
 * cuesta UNA lectura por índice y ningún candado ni SQL crudo; el camino a cantidad ni mira a Shopify (B7).
 */
import type { Prisma } from '@prisma/client'
import { switchInventoryMethod } from '@/services/dashboard/productWizard.service'

function fakeDb(method: 'RECIPE' | 'QUANTITY') {
  const db = {
    product: {
      findUnique: jest.fn().mockResolvedValue({ venueId: 'v1' }),
      update: jest
        .fn()
        .mockResolvedValue({ id: 'p1', venueId: 'v1', trackInventory: true, inventoryMethod: method, deletedAt: null, deletedBy: null }),
    },
    shopifyVariantLink: { findUnique: jest.fn().mockResolvedValue(null) },
    shopifyLocationLink: { updateMany: jest.fn() },
    inventory: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }), createMany: jest.fn() },
    recipeLine: { deleteMany: jest.fn() },
    recipe: { deleteMany: jest.fn() },
    $queryRaw: jest.fn(),
  }
  return { db, tx: db as unknown as Prisma.TransactionClient }
}

describe('switchInventoryMethod · conector Shopify (B7)', () => {
  it('a receta sin pareja: una lectura por índice, ningún SQL crudo, y el Inventory se borra como siempre', async () => {
    const { db, tx } = fakeDb('RECIPE')
    await expect(switchInventoryMethod('v1', 'p1', 'RECIPE', tx)).resolves.toMatchObject({ success: true, newMethod: 'RECIPE' })
    expect(db.shopifyVariantLink.findUnique).toHaveBeenCalledTimes(1)
    expect(db.shopifyVariantLink.findUnique).toHaveBeenCalledWith({ where: { productId: 'p1' }, select: { id: true } })
    expect(db.$queryRaw).not.toHaveBeenCalled()
    expect(db.inventory.deleteMany).toHaveBeenCalledWith({ where: { productId: 'p1' } })
  })

  it('a cantidad sin pareja: una lectura por índice y ninguna escritura a Shopify', async () => {
    const { db, tx } = fakeDb('QUANTITY')
    await switchInventoryMethod('v1', 'p1', 'QUANTITY', tx)
    expect(db.shopifyVariantLink.findUnique).toHaveBeenCalledTimes(1)
    expect(db.shopifyLocationLink.updateMany).not.toHaveBeenCalled()
    expect(db.$queryRaw).not.toHaveBeenCalled()
    expect(db.inventory.deleteMany).not.toHaveBeenCalled()
  })

  it('a cantidad con la pareja suspendida por la receta: UNA escritura, el cuadre de su sucursal', async () => {
    const { db, tx } = fakeDb('QUANTITY')
    db.shopifyVariantLink.findUnique.mockResolvedValue({ locationLinkId: 'l1', suspendedReason: 'SIN_INVENTARIO' })
    await switchInventoryMethod('v1', 'p1', 'QUANTITY', tx)
    expect(db.shopifyLocationLink.updateMany).toHaveBeenCalledTimes(1)
    expect(db.shopifyLocationLink.updateMany).toHaveBeenCalledWith({
      where: { id: 'l1', status: 'ACTIVE' },
      data: { needsReconcile: true, reconcileVersion: { increment: 1 } },
    })
  })
})
