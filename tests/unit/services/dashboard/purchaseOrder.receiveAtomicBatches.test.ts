/**
 * receivePurchaseOrder (camino legacy "Recibir todo") — fase 3 del plan de
 * inventario: los lotes se crean DENTRO de la transacción.
 *
 * Antes, `createStockBatch` corría FUERA de la $transaction (forma de arreglo,
 * sin cliente `tx`): si la transacción fallaba después, los lotes ya estaban
 * commiteados — inventario fantasma en FIFO sin saldo ni movimiento que los
 * respalde (misma clase de bug que la firma #27 de adjustStock). Además, el
 * kardex escribía previousStock/newStock desde la lectura hecha al INICIO de
 * la función, no del valor real al aplicar.
 *
 * Fix: forma de callback — lote + renglón + increment + movimiento + metadata
 * en UNA transacción; el kardex deriva previousStock/newStock del RESULTADO
 * del increment atómico.
 */

import { Unit, RawMaterialMovementType } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { prismaMock } from '../../../__helpers__/setup'
import { receivePurchaseOrder } from '../../../../src/services/dashboard/purchaseOrder.service'
import { createStockBatch } from '../../../../src/services/dashboard/fifoBatch.service'

jest.mock('../../../../src/services/dashboard/fifoBatch.service', () => {
  const actual = jest.requireActual('../../../../src/services/dashboard/fifoBatch.service')
  return {
    ...actual,
    createStockBatch: jest.fn(),
  }
})

const VENUE_ID = 'venue-1'
const PO_ID = 'po-1'
const STAFF_ID = 'staff-1'

const mockRawMaterial = () => ({
  id: 'rm-harina',
  venueId: VENUE_ID,
  name: 'Harina',
  unit: Unit.GRAM,
  currentStock: new Decimal(100),
  perishable: false,
  shelfLifeDays: null,
})

const mockOrder = () => ({
  id: PO_ID,
  venueId: VENUE_ID,
  orderNumber: 'PO-001',
  status: 'CONFIRMED',
  items: [
    {
      id: 'poi-1',
      productId: null,
      product: null,
      rawMaterial: mockRawMaterial(),
      rawMaterialId: 'rm-harina',
      quantityOrdered: new Decimal(500),
      quantityReceived: new Decimal(0),
      unit: Unit.GRAM,
      unitPrice: new Decimal('0.02'),
      presentationFactor: null,
    },
  ],
})

describe('receivePurchaseOrder — lotes dentro de la transacción', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (arg: any) => (typeof arg === 'function' ? arg(prismaMock) : Promise.all(arg)))
    prismaMock.purchaseOrder.findFirst.mockResolvedValue(mockOrder())
    prismaMock.purchaseOrder.findUnique.mockResolvedValue(mockOrder())
    prismaMock.purchaseOrder.update.mockResolvedValue({})
    prismaMock.purchaseOrderItem.update.mockResolvedValue({})
    prismaMock.purchaseOrderItem.findMany.mockResolvedValue([
      { id: 'poi-1', receiveStatus: 'RECEIVED', quantityOrdered: new Decimal(500), quantityReceived: new Decimal(50) },
    ])
    prismaMock.rawMaterialMovement.create.mockResolvedValue({})
    ;(createStockBatch as jest.Mock).mockResolvedValue({
      id: 'batch-1',
      batchNumber: 'BATCH-20260813-001',
      costPerUnit: new Decimal('0.02'),
    })
  })

  const receive = () =>
    receivePurchaseOrder(
      VENUE_ID,
      PO_ID,
      { receivedDate: '2026-08-13', items: [{ purchaseOrderItemId: 'poi-1', quantityReceived: 50 }] } as any,
      STAFF_ID,
    )

  it('createStockBatch corre con el cliente tx y skipAudit (nunca fuera de la transacción)', async () => {
    // Con el increment atómico el update devuelve el saldo YA resuelto.
    prismaMock.rawMaterial.update.mockResolvedValue({ ...mockRawMaterial(), currentStock: new Decimal(150) })

    await receive()

    const call = (createStockBatch as jest.Mock).mock.calls[0]
    // 5º argumento = cliente de transacción (en el mock, prismaMock hace de tx).
    expect(call[4]).toBe(prismaMock)
    // 6º argumento = skipAudit: el caller audita DESPUÉS del commit.
    expect(call[5]).toEqual({ skipAudit: true })
  })

  it('el kardex deriva previousStock/newStock del increment atómico, no de la lectura inicial', async () => {
    // Lectura al inicio: 100. Otra recepción concurrente metió +30 → la base
    // resuelve 100 + 30 + 50 = 180.
    prismaMock.rawMaterial.update.mockResolvedValue({ ...mockRawMaterial(), currentStock: new Decimal(180) })

    await receive()

    const movement = prismaMock.rawMaterialMovement.create.mock.calls[0][0]
    expect(movement.data.type).toBe(RawMaterialMovementType.PURCHASE)
    expect(Number(movement.data.previousStock)).toBe(130)
    expect(Number(movement.data.newStock)).toBe(180)
    expect(movement.data.batchId).toBe('batch-1')
  })

  it('el saldo se escribe con { increment }, nunca como valor absoluto', async () => {
    prismaMock.rawMaterial.update.mockResolvedValue({ ...mockRawMaterial(), currentStock: new Decimal(150) })

    await receive()

    expect(prismaMock.rawMaterial.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ currentStock: { increment: expect.anything() } }),
      }),
    )
  })
})
