/**
 * Regression tests for the mobile receiveStock flow (TPV/POS apps).
 *
 * Bug (auditoría FIFO 2026-06-11): receiveStock incrementaba
 * RawMaterial.currentStock y creaba el movimiento, pero NUNCA creaba el
 * StockBatch (stock invisible para FIFO), no convertía unidades OC→insumo
 * (recibir 5 KG de un insumo en GRAM sumaba 5 en vez de 5000), corría fuera
 * de transacción y aceptaba sobre-recepciones ilimitadas.
 *
 * Estos tests fallan con la implementación rota y pasan con el fix (que
 * delega en applyItemReceiveStatusInTx, la misma lógica del dashboard).
 */

import prisma from '@/utils/prismaClient'
import { receiveStock } from '@/services/mobile/purchase-order.mobile.service'
import { BadRequestError } from '@/errors/AppError'
import { Decimal } from '@prisma/client/runtime/library'
import { PurchaseOrderItemStatus, RawMaterialMovementType } from '@prisma/client'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    purchaseOrder: { findFirst: jest.fn(), update: jest.fn() },
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

/** Item de OC: 5 KILOGRAM ordenados a $5/KG de un insumo almacenado en GRAM con 1000g. */
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
      sku: 'HAR-01',
      unit: 'GRAM',
      currentStock: new Decimal(1000),
      perishable: false,
      shelfLifeDays: null,
    },
    batches: [],
    purchaseOrder: { id: PO_ID, orderNumber: 'PO-MOB-001' },
    ...overrides,
  }
}

function makePo(items: any[], status = 'CONFIRMED') {
  const now = new Date('2026-06-10T12:00:00.000Z')
  return {
    id: PO_ID,
    venueId: VENUE_ID,
    status,
    orderNumber: 'PO-MOB-001',
    supplier: { id: 'sup-1', name: 'Proveedor' },
    supplierId: 'sup-1',
    items,
    orderDate: now,
    expectedDeliveryDate: null,
    receivedDate: null,
    subtotal: new Decimal(25),
    taxAmount: new Decimal(0),
    total: new Decimal(25),
    notes: null,
    createdBy: 'staff-1',
    createdAt: now,
    updatedAt: now,
  }
}

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
  const item = makeItem()
  mockedPrisma.purchaseOrder.findFirst.mockResolvedValue(makePo([item]))
  mockedPrisma.purchaseOrder.update.mockResolvedValue({})
  mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(item)
  mockedPrisma.purchaseOrderItem.update.mockResolvedValue({})
  mockedPrisma.rawMaterial.findFirst.mockResolvedValue(item.rawMaterial)
  mockedPrisma.rawMaterial.update.mockResolvedValue({})
  mockedPrisma.rawMaterialMovement.create.mockResolvedValue({})
  mockedPrisma.stockBatch.findFirst.mockResolvedValue(null)
  mockedPrisma.stockBatch.create.mockImplementation(async ({ data }: any) => ({ id: 'batch-new', ...data }))
})

describe('receiveStock (mobile) — invariante FIFO y conversión de unidades', () => {
  it('crea un StockBatch por la cantidad recibida (en unidad del insumo, costo normalizado)', async () => {
    await receiveStock(PO_ID, VENUE_ID, [{ itemId: ITEM_ID, receivedQuantity: 5 }], 'staff-1')

    expect(mockedPrisma.stockBatch.create).toHaveBeenCalledTimes(1)
    const batch = mockedPrisma.stockBatch.create.mock.calls[0][0].data
    expect(new Decimal(batch.initialQuantity).toNumber()).toBe(5000) // 5 KG → 5000 g
    expect(new Decimal(batch.remainingQuantity).toNumber()).toBe(5000)
    expect(batch.unit).toBe('GRAM')
    expect(new Decimal(batch.costPerUnit).toNumber()).toBeCloseTo(0.005, 10) // $5/KG → $0.005/g
    expect(batch.purchaseOrderItemId).toBe(ITEM_ID)
  })

  it('convierte la cantidad a la unidad del insumo al actualizar currentStock y el movimiento', async () => {
    await receiveStock(PO_ID, VENUE_ID, [{ itemId: ITEM_ID, receivedQuantity: 5 }], 'staff-1')

    const stockArg = mockedPrisma.rawMaterial.update.mock.calls[0][0].data.currentStock
    expect(new Decimal(stockArg).toNumber()).toBe(6000) // 1000 g + 5000 g

    const movement = mockedPrisma.rawMaterialMovement.create.mock.calls[0][0].data
    expect(movement.type).toBe(RawMaterialMovementType.PURCHASE)
    expect(new Decimal(movement.quantity).toNumber()).toBe(5000)
    expect(movement.unit).toBe('GRAM')
    expect(movement.batchId).toBeDefined()
  })

  it('rechaza sobre-recepción: recibir más de lo ordenado lanza error y no toca inventario', async () => {
    const partialItem = makeItem({ quantityReceived: new Decimal(4) })
    mockedPrisma.purchaseOrder.findFirst.mockResolvedValue(makePo([partialItem]))
    mockedPrisma.purchaseOrderItem.findFirst.mockResolvedValue(partialItem)

    await expect(receiveStock(PO_ID, VENUE_ID, [{ itemId: ITEM_ID, receivedQuantity: 2 }], 'staff-1')).rejects.toThrow(BadRequestError)

    expect(mockedPrisma.stockBatch.create).not.toHaveBeenCalled()
    expect(mockedPrisma.rawMaterial.update).not.toHaveBeenCalled()
    expect(mockedPrisma.rawMaterialMovement.create).not.toHaveBeenCalled()
  })

  it('procesa la recepción dentro de una transacción (batch + stock + movimiento atómicos)', async () => {
    await receiveStock(PO_ID, VENUE_ID, [{ itemId: ITEM_ID, receivedQuantity: 5 }], 'staff-1')

    expect(mockedPrisma.$transaction).toHaveBeenCalled()
  })
})
