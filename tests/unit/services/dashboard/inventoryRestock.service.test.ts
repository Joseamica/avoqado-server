import { Decimal } from '@prisma/client/runtime/library'
import { restockItem, restockOrderItems } from '@/services/dashboard/inventoryRestock.service'
import { adjustStock } from '@/services/dashboard/rawMaterial.service'
import { prismaMock } from '../../../__helpers__/setup'

jest.mock('@/services/dashboard/rawMaterial.service', () => ({
  adjustStock: jest.fn(),
}))

const adjustStockMock = adjustStock as jest.Mock

describe('inventoryRestock.service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // $transaction(cb) → run callback with the mock client (matches existing dashboard test).
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
  })

  // ───────────────────────────── restockItem ─────────────────────────────
  describe('restockItem', () => {
    it('QUANTITY: increments Inventory.currentStock and records an ADJUSTMENT movement', async () => {
      prismaMock.product.findUnique.mockResolvedValue({
        id: 'p1',
        name: 'Calcetines',
        inventoryMethod: 'QUANTITY',
        trackInventory: true,
      } as any)
      prismaMock.inventory.findUnique.mockResolvedValue({ id: 'inv1', productId: 'p1' } as any)
      prismaMock.inventory.update.mockResolvedValue({ currentStock: new Decimal(22) } as any)
      prismaMock.inventoryMovement.create.mockResolvedValue({ id: 'mov1' } as any)

      await restockItem({ venueId: 'v1', productId: 'p1', quantity: 1, refundPaymentId: 'r1', staffId: 's1' })

      expect(prismaMock.inventory.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { productId: 'p1' }, data: { currentStock: { increment: 1 } } }),
      )
      expect(prismaMock.inventoryMovement.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ inventoryId: 'inv1', type: 'ADJUSTMENT', reference: 'r1', createdBy: 's1' }),
        }),
      )
      // QUANTITY must NOT touch the recipe/FIFO path.
      expect(adjustStockMock).not.toHaveBeenCalled()
    })

    it('RECIPE: calls adjustStock per non-optional/non-variable line, scaled by portions', async () => {
      prismaMock.product.findUnique.mockResolvedValue({
        id: 'p2',
        name: 'Latte',
        inventoryMethod: 'RECIPE',
        trackInventory: true,
      } as any)
      prismaMock.recipe.findUnique.mockResolvedValue({
        id: 'rec1',
        lines: [
          { rawMaterialId: 'rm1', quantity: new Decimal(10), isOptional: false, isVariable: false },
          { rawMaterialId: 'rm2', quantity: new Decimal(5), isOptional: true, isVariable: false }, // skipped (optional)
          { rawMaterialId: 'rm3', quantity: new Decimal(2), isOptional: false, isVariable: true }, // skipped (variable)
        ],
      } as any)

      await restockItem({ venueId: 'v1', productId: 'p2', quantity: 3, refundPaymentId: 'r2', staffId: 's1' })

      expect(adjustStockMock).toHaveBeenCalledTimes(1)
      expect(adjustStockMock).toHaveBeenCalledWith(
        'v1',
        'rm1',
        expect.objectContaining({ quantity: 30, type: 'ADJUSTMENT', reference: 'r2' }),
        's1',
      )
    })

    it('no-ops for products that do not track inventory', async () => {
      prismaMock.product.findUnique.mockResolvedValue({
        id: 'p3',
        name: 'Servicio',
        inventoryMethod: null,
        trackInventory: false,
      } as any)

      await restockItem({ venueId: 'v1', productId: 'p3', quantity: 1, refundPaymentId: 'r3' })

      expect(prismaMock.inventory.update).not.toHaveBeenCalled()
      expect(adjustStockMock).not.toHaveBeenCalled()
    })
  })

  // ─────────────────────────── restockOrderItems ──────────────────────────
  describe('restockOrderItems', () => {
    it('restocks each inventory item of the order and skips items without a productId', async () => {
      prismaMock.orderItem.findMany.mockResolvedValue([
        { id: 'oi1', productId: 'p1', quantity: 2 },
        { id: 'oi2', productId: null, quantity: 1 }, // guarded out (no product)
      ] as any)
      prismaMock.product.findUnique.mockResolvedValue({
        id: 'p1',
        name: 'X',
        inventoryMethod: 'QUANTITY',
        trackInventory: true,
      } as any)
      prismaMock.inventory.findUnique.mockResolvedValue({ id: 'inv1', productId: 'p1' } as any)
      prismaMock.inventory.update.mockResolvedValue({ currentStock: new Decimal(5) } as any)
      prismaMock.inventoryMovement.create.mockResolvedValue({ id: 'mov1' } as any)

      const res = await restockOrderItems({ venueId: 'v1', orderId: 'o1', refundPaymentId: 'r1', staffId: 's1' })

      expect(prismaMock.orderItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { orderId: 'o1', productId: { not: null } } }),
      )
      expect(prismaMock.inventory.update).toHaveBeenCalledTimes(1) // only the item with a productId
      expect(res).toEqual({ items: 2, restocked: 1 })
    })

    it('is best-effort: one item failing does not stop the rest', async () => {
      prismaMock.orderItem.findMany.mockResolvedValue([
        { id: 'oi1', productId: 'p1', quantity: 1 },
        { id: 'oi2', productId: 'p2', quantity: 1 },
      ] as any)
      prismaMock.product.findUnique
        .mockRejectedValueOnce(new Error('db blip')) // p1 throws → caught, not counted
        .mockResolvedValueOnce({ id: 'p2', inventoryMethod: null, trackInventory: false } as any) // p2 no-op → counted

      const res = await restockOrderItems({ venueId: 'v1', orderId: 'o1', refundPaymentId: 'r1' })

      expect(res.items).toBe(2)
      expect(res.restocked).toBe(1)
    })
  })
})
