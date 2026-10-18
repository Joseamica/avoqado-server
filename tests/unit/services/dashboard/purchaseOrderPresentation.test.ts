import { Decimal } from '@prisma/client/runtime/library'
import { Unit } from '@prisma/client'
import { prismaMock } from '../../../__helpers__/setup'
import { receivePurchaseOrder } from '@/services/dashboard/purchaseOrder.service'
import { createStockBatch } from '@/services/dashboard/fifoBatch.service'

jest.mock('@/services/dashboard/fifoBatch.service', () => ({
  ...jest.requireActual('@/services/dashboard/fifoBatch.service'),
  createStockBatch: jest.fn(),
}))

/**
 * Recibir una compra ejecuta el servicio real: el factor llega al lote, saldo y movimiento.
 * FIFO está aislado para comprobar lo que el servicio le entrega, no el valor que devuelve el mock.
 */
describe('receivePurchaseOrder — presentación en el servicio real', () => {
  const order = (overrides: Record<string, unknown> = {}) => ({
    id: 'po-presentacion',
    venueId: 'venue-presentacion',
    orderNumber: 'PO-PRESENTACION',
    status: 'CONFIRMED',
    items: [
      {
        id: 'poi-presentacion',
        productId: null,
        rawMaterialId: 'rm-presentacion',
        quantityOrdered: new Decimal(50),
        quantityReceived: new Decimal(0),
        unit: Unit.PIECE,
        unitPrice: new Decimal(360),
        presentationFactor: new Decimal(360),
        rawMaterial: {
          id: 'rm-presentacion',
          name: 'Insumo',
          venueId: 'venue-presentacion',
          unit: Unit.PIECE as Unit,
          currentStock: new Decimal(0),
          perishable: false,
        },
        ...overrides,
      },
    ],
  })

  let transactionClient: typeof prismaMock

  beforeEach(() => {
    jest.clearAllMocks()
    transactionClient = { ...prismaMock }
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(transactionClient))
    prismaMock.purchaseOrder.findFirst.mockResolvedValue(order())
    prismaMock.purchaseOrder.findUnique.mockResolvedValue(order())
    prismaMock.purchaseOrder.update.mockResolvedValue({})
    prismaMock.purchaseOrderItem.update.mockResolvedValue({})
    prismaMock.purchaseOrderItem.findMany.mockResolvedValue([
      { id: 'poi-presentacion', receiveStatus: 'RECEIVED', quantityOrdered: new Decimal(50), quantityReceived: new Decimal(50) },
    ])
    prismaMock.rawMaterialMovement.create.mockResolvedValue({})
  })

  const receive = (quantityReceived: number) =>
    receivePurchaseOrder(
      'venue-presentacion',
      'po-presentacion',
      { receivedDate: '2026-10-15', items: [{ purchaseOrderItemId: 'poi-presentacion', quantityReceived }] },
      'staff-presentacion',
    )

  it.each([
    {
      caso: '50 cajas',
      quantity: 50,
      factor: 360,
      price: 360,
      unit: Unit.PIECE,
      base: Unit.PIECE,
      stock: 18000,
      batchQuantity: 18000,
      batchUnit: Unit.PIECE,
      batchCost: 1,
      normalizedCost: 1,
      value: 18000,
    },
    {
      caso: 'recepción parcial de 10 cajas',
      quantity: 10,
      factor: 360,
      price: 360,
      unit: Unit.PIECE,
      base: Unit.PIECE,
      stock: 3600,
      batchQuantity: 3600,
      batchUnit: Unit.PIECE,
      batchCost: 1,
      normalizedCost: 1,
      value: 3600,
    },
    {
      caso: 'factor fraccionario',
      quantity: 3,
      factor: 18.18,
      price: 50,
      unit: Unit.KILOGRAM,
      base: Unit.PIECE,
      stock: 54.54,
      batchQuantity: 54.54,
      batchUnit: Unit.PIECE,
      batchCost: 2.75027502750275,
      normalizedCost: 2.75027502750275,
      value: 150,
    },
    {
      caso: 'legacy en la misma unidad',
      quantity: 5,
      factor: null,
      price: 80,
      unit: Unit.KILOGRAM,
      base: Unit.KILOGRAM,
      stock: 5,
      batchQuantity: 5,
      batchUnit: Unit.KILOGRAM,
      batchCost: 80,
      normalizedCost: 80,
      value: 400,
    },
    {
      caso: 'legacy de kilos a gramos sin convertir dos veces el lote',
      quantity: 2,
      factor: null,
      price: 80,
      unit: Unit.KILOGRAM,
      base: Unit.GRAM,
      stock: 2000,
      batchQuantity: 2,
      batchUnit: Unit.KILOGRAM,
      batchCost: 80,
      normalizedCost: 0.08,
      value: 160,
    },
  ])('$caso: lote, saldo y movimiento conservan cantidad y valor', async fixture => {
    const po = order({
      unit: fixture.unit,
      unitPrice: new Decimal(fixture.price),
      presentationFactor: fixture.factor === null ? null : new Decimal(fixture.factor),
    })
    po.items[0].rawMaterial.unit = fixture.base
    prismaMock.purchaseOrder.findFirst.mockResolvedValue(po)
    prismaMock.rawMaterial.update.mockResolvedValue({ ...po.items[0].rawMaterial, currentStock: new Decimal(fixture.stock) })
    ;(createStockBatch as jest.Mock).mockResolvedValue({
      id: 'batch-presentacion',
      batchNumber: 'BATCH-PRESENTACION',
      costPerUnit: new Decimal(fixture.normalizedCost),
    })

    await receive(fixture.quantity)

    expect(createStockBatch).toHaveBeenCalledTimes(1)
    const [venueId, rawMaterialId, batch, staffId, tx, options] = (createStockBatch as jest.Mock).mock.calls[0]
    expect([venueId, rawMaterialId, staffId]).toEqual(['venue-presentacion', 'rm-presentacion', 'staff-presentacion'])
    expect(tx).toBe(transactionClient)
    expect(options).toEqual({ skipAudit: true })
    expect(batch.quantity).toBe(fixture.batchQuantity)
    expect(batch.unit).toBe(fixture.batchUnit)
    expect(batch.costPerUnit).toBeCloseTo(fixture.batchCost, 10)
    expect(batch.quantity * batch.costPerUnit).toBeCloseTo(fixture.value, 6)
    const stockWrite = prismaMock.rawMaterial.update.mock.calls[0][0]
    expect(stockWrite.where).toEqual({ id: 'rm-presentacion' })
    expect(Number(stockWrite.data.currentStock.increment)).toBe(fixture.stock)
    const movement = prismaMock.rawMaterialMovement.create.mock.calls[0][0].data
    expect(movement).toMatchObject({
      venueId: 'venue-presentacion',
      rawMaterialId: 'rm-presentacion',
      batchId: 'batch-presentacion',
      unit: fixture.base,
      type: 'PURCHASE',
    })
    expect(Number(movement.quantity)).toBe(fixture.stock)
    expect(Number(movement.previousStock)).toBe(0)
    expect(Number(movement.newStock)).toBe(fixture.stock)
    expect(Number(movement.costImpact)).toBeCloseTo(fixture.value, 6)
  })

  it.each([0, -1])('rechaza factor %s antes de crear lote, saldo o movimiento', async factor => {
    prismaMock.purchaseOrder.findFirst.mockResolvedValue(order({ presentationFactor: new Decimal(factor) }))

    await expect(receive(1)).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('factor') })

    expect(createStockBatch).not.toHaveBeenCalled()
    expect(prismaMock.rawMaterial.update).not.toHaveBeenCalled()
    expect(prismaMock.rawMaterialMovement.create).not.toHaveBeenCalled()
  })

  it('rechaza unidades legacy incompatibles antes de crear lote, saldo o movimiento', async () => {
    prismaMock.purchaseOrder.findFirst.mockResolvedValue(order({ presentationFactor: null, unit: Unit.LITER }))

    await expect(receive(1)).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('incompatible') })

    expect(createStockBatch).not.toHaveBeenCalled()
    expect(prismaMock.rawMaterial.update).not.toHaveBeenCalled()
    expect(prismaMock.rawMaterialMovement.create).not.toHaveBeenCalled()
  })
})
