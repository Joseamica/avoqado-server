/**
 * Regression tests for receiveAllItems ("Recibir todo").
 *
 * Bug (auditoría FIFO 2026-06-11): receiveAllItems creaba StockBatch pero
 * NUNCA incrementaba RawMaterial.currentStock ni creaba RawMaterialMovement,
 * el batch se creaba con el cliente global (escapaba la transacción), no
 * convertía unidades OC→insumo y una doble llamada duplicaba lotes.
 *
 * Estos tests fallan con la implementación rota y pasan con el fix (que
 * delega en la misma lógica transaccional de updatePurchaseOrderItemStatus).
 */

import prisma from '@/utils/prismaClient'
import { receiveAllItems } from '@/services/dashboard/purchaseOrder.service'
import AppError from '@/errors/AppError'
import { Decimal } from '@prisma/client/runtime/library'
import { BatchStatus, PurchaseOrderItemStatus, PurchaseOrderStatus, RawMaterialMovementType } from '@prisma/client'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    purchaseOrder: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), update: jest.fn(), updateMany: jest.fn(), findFirst: jest.fn() },
    purchaseOrderItem: { findFirst: jest.fn(), update: jest.fn() },
    rawMaterial: { findFirst: jest.fn(), update: jest.fn() },
    stockBatch: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    rawMaterialMovement: { create: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn(),
}))

const mockedPrisma = prisma as unknown as Record<string, Record<string, jest.Mock>> & { $transaction: jest.Mock }

const VENUE_ID = 'venue-1'
const PO_ID = 'po-1'
const ITEM_ID = 'item-1'
const RM_ID = 'rm-1'

/** Item de OC: 5 KILOGRAM ordenados a $5/KG de un insumo almacenado en GRAM con 1000g en stock. */
function makeItem(overrides: Partial<any> = {}) {
  return {
    id: ITEM_ID,
    purchaseOrderId: PO_ID,
    rawMaterialId: RM_ID,
    quantityOrdered: new Decimal(5),
    quantityReceived: new Decimal(0),
    unit: 'KILOGRAM',
    receiveStatus: PurchaseOrderItemStatus.PENDING,
    unitPrice: new Decimal(5),
    total: new Decimal(25),
    notes: null,
    rawMaterial: {
      id: RM_ID,
      name: 'Harina',
      unit: 'GRAM',
      currentStock: new Decimal(1000),
      perishable: false,
      shelfLifeDays: null,
    },
    batches: [],
    purchaseOrder: { id: PO_ID, orderNumber: 'PO-TEST-001' },
    ...overrides,
  }
}

function makePo(items: any[], status: PurchaseOrderStatus = PurchaseOrderStatus.CONFIRMED) {
  return { id: PO_ID, venueId: VENUE_ID, status, orderNumber: 'PO-TEST-001', items }
}

/** Igual que el cliente real: tx.* proxya a los mismos modelos del mock. */
function wireTransaction() {
  mockedPrisma.$transaction.mockImplementation(async (cb: (tx: any) => Promise<any>) => {
    const tx = {
      purchaseOrder: mockedPrisma.purchaseOrder,
      purchaseOrderItem: mockedPrisma.purchaseOrderItem,
      rawMaterial: mockedPrisma.rawMaterial,
      stockBatch: mockedPrisma.stockBatch,
      rawMaterialMovement: mockedPrisma.rawMaterialMovement,
    }
    return cb(tx)
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  wireTransaction()
  mockedPrisma.purchaseOrder.updateMany.mockResolvedValue({ count: 1 })
  mockedPrisma.purchaseOrder.update.mockResolvedValue({})
  mockedPrisma.purchaseOrder.findUniqueOrThrow.mockResolvedValue(makePo([makeItem()], PurchaseOrderStatus.RECEIVED))
  mockedPrisma.purchaseOrderItem.update.mockResolvedValue({})
  mockedPrisma.rawMaterial.update.mockResolvedValue({})
  mockedPrisma.rawMaterialMovement.create.mockResolvedValue({})
  mockedPrisma.stockBatch.findFirst.mockResolvedValue(null)
  mockedPrisma.stockBatch.create.mockImplementation(async ({ data }: any) => ({ id: 'batch-new', ...data }))
  // El RM existe tanto para el path viejo (createStockBatch global) como el nuevo
  mockedPrisma.rawMaterial.findFirst.mockResolvedValue(makeItem().rawMaterial)
})

describe('receiveAllItems — invariante FIFO (currentStock === Σ lotes ACTIVE)', () => {
  it('incrementa RawMaterial.currentStock y crea un RawMaterialMovement PURCHASE en la unidad del insumo', async () => {
    const item = makeItem()
    mockedPrisma.purchaseOrder.findUnique.mockResolvedValue(makePo([item]))
    mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(item)

    await receiveAllItems(VENUE_ID, PO_ID, {})

    // 5 KG → 5000 g sobre 1000 g existentes = 6000 g
    expect(mockedPrisma.rawMaterial.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: RM_ID },
        data: expect.objectContaining({ currentStock: expect.anything() }),
      }),
    )
    const stockArg = mockedPrisma.rawMaterial.update.mock.calls[0][0].data.currentStock
    expect(new Decimal(stockArg).toNumber()).toBe(6000)

    expect(mockedPrisma.rawMaterialMovement.create).toHaveBeenCalledTimes(1)
    const movement = mockedPrisma.rawMaterialMovement.create.mock.calls[0][0].data
    expect(movement.type).toBe(RawMaterialMovementType.PURCHASE)
    expect(new Decimal(movement.quantity).toNumber()).toBe(5000)
    expect(movement.unit).toBe('GRAM')
    expect(new Decimal(movement.previousStock).toNumber()).toBe(1000)
    expect(new Decimal(movement.newStock).toNumber()).toBe(6000)
    expect(movement.batchId).toBeDefined()

    // El batch queda en unidad del insumo con costo normalizado ($5/KG → $0.005/g)
    const batch = mockedPrisma.stockBatch.create.mock.calls[0][0].data
    expect(new Decimal(batch.initialQuantity).toNumber()).toBe(5000)
    expect(batch.unit).toBe('GRAM')
    expect(new Decimal(batch.costPerUnit).toNumber()).toBeCloseTo(0.005, 10)
  })

  it('es idempotente: un item ya recibido por completo no genera lotes ni stock duplicado', async () => {
    const receivedItem = makeItem({
      quantityReceived: new Decimal(5),
      receiveStatus: PurchaseOrderItemStatus.RECEIVED,
      batches: [
        {
          id: 'batch-old',
          status: BatchStatus.ACTIVE,
          initialQuantity: new Decimal(5000),
          remainingQuantity: new Decimal(5000),
          receivedDate: new Date('2026-06-01'),
          depletedAt: null,
        },
      ],
    })
    mockedPrisma.purchaseOrder.findUnique.mockResolvedValue(makePo([receivedItem]))
    mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(receivedItem)

    await receiveAllItems(VENUE_ID, PO_ID, {})

    expect(mockedPrisma.stockBatch.create).not.toHaveBeenCalled()
    expect(mockedPrisma.rawMaterialMovement.create).not.toHaveBeenCalled()
    expect(mockedPrisma.rawMaterial.update).not.toHaveBeenCalled()
  })

  it('rechaza una recepción concurrente: si otro proceso ya tomó la orden, no toca inventario', async () => {
    const item = makeItem()
    mockedPrisma.purchaseOrder.findUnique.mockResolvedValue(makePo([item]))
    mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(item)
    // La transición condicional de status no encuentra filas: otra tx ya recibió
    mockedPrisma.purchaseOrder.updateMany.mockResolvedValue({ count: 0 })

    await expect(receiveAllItems(VENUE_ID, PO_ID, {})).rejects.toThrow(AppError)

    expect(mockedPrisma.stockBatch.create).not.toHaveBeenCalled()
    expect(mockedPrisma.rawMaterial.update).not.toHaveBeenCalled()
    expect(mockedPrisma.rawMaterialMovement.create).not.toHaveBeenCalled()
  })

  it('calcula expirationDate para insumos perecederos', async () => {
    const perishableItem = makeItem({
      rawMaterial: {
        ...makeItem().rawMaterial,
        perishable: true,
        shelfLifeDays: 7,
      },
    })
    mockedPrisma.purchaseOrder.findUnique.mockResolvedValue(makePo([perishableItem]))
    mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(perishableItem)
    mockedPrisma.rawMaterial.findFirst.mockResolvedValue(perishableItem.rawMaterial)

    const receivedDate = '2026-06-10T12:00:00.000Z'
    await receiveAllItems(VENUE_ID, PO_ID, { receivedDate })

    const batch = mockedPrisma.stockBatch.create.mock.calls[0][0].data
    expect(batch.expirationDate).toBeInstanceOf(Date)
    const expected = new Date(receivedDate)
    expected.setDate(expected.getDate() + 7)
    expect((batch.expirationDate as Date).toISOString().slice(0, 10)).toBe(expected.toISOString().slice(0, 10))
  })
})
