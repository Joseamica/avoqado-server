/**
 * Regression — adjustStock (insumos): lost update en la adición manual.
 *
 * La rama de adición calculaba `newStock = currentStock(leído al inicio) + qty`
 * y lo escribía como VALOR ABSOLUTO. Dos ajustes concurrentes (o un ajuste
 * concurrente con una recepción de OC) leían el mismo saldo y la segunda
 * escritura PISABA a la primera — una entrada completa perdida en silencio.
 * (Mismo bug que ya se corrigió en receivePurchaseOrder; auditoría 2026-08-12.)
 *
 * Fix: `currentStock: { increment: qty }` (la base resuelve la suma
 * atómicamente) y el movimiento del kardex deriva previousStock/newStock del
 * RESULTADO del update — no de la lectura vieja — para que la cadena
 * previousStock/newStock del kardex no mienta bajo concurrencia.
 */

import { Unit, RawMaterialMovementType } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { adjustStock } from '@/services/dashboard/rawMaterial.service'
import { createStockBatch } from '@/services/dashboard/fifoBatch.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/services/dashboard/fifoBatch.service', () => {
  const actual = jest.requireActual('@/services/dashboard/fifoBatch.service')
  return {
    ...actual,
    deductStockFIFO: jest.fn(),
    deductStockFIFOInTx: jest.fn(),
    createStockBatch: jest.fn(),
  }
})

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    rawMaterial: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    rawMaterialMovement: { create: jest.fn() },
    lowStockAlert: { findFirst: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/services/dashboard/notification.service', () => ({
  sendLowStockAlertNotification: jest.fn(),
}))

jest.mock('@/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn(),
}))

const VENUE_ID = 'venue-1'
const RM_ID = 'rm-cafe'

const mockCafe = (stock: number) => ({
  id: RM_ID,
  venueId: VENUE_ID,
  name: 'Café',
  unit: Unit.GRAM,
  currentStock: new Decimal(stock),
  reorderPoint: new Decimal(0),
  costPerUnit: new Decimal('0.05'),
  perishable: false,
  shelfLifeDays: null,
  lastCountAt: null,
})

describe('adjustStock — la adición usa incremento atómico, no asignación absoluta', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(prisma))
    ;(prisma.lowStockAlert.findFirst as jest.Mock).mockResolvedValue(null)
    ;(createStockBatch as jest.Mock).mockResolvedValue({
      id: 'batch-1',
      batchNumber: 'BATCH-X',
      costPerUnit: new Decimal('0.05'),
    })
    ;(prisma.rawMaterialMovement.create as jest.Mock).mockResolvedValue({})
  })

  it('escribe currentStock con { increment }, nunca un valor absoluto', async () => {
    ;(prisma.rawMaterial.findFirst as jest.Mock).mockResolvedValue(mockCafe(1000))
    ;(prisma.rawMaterial.update as jest.Mock).mockResolvedValue(mockCafe(1500))

    await adjustStock(VENUE_ID, RM_ID, { quantity: 500, type: RawMaterialMovementType.ADJUSTMENT } as any, 'staff-1')

    expect(prisma.rawMaterial.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ currentStock: { increment: 500 } }),
      }),
    )
  })

  it('el kardex deriva previousStock/newStock del RESULTADO atómico, no de la lectura vieja', async () => {
    // Lectura al inicio: 1000. Entre la lectura y el update, una recepción
    // concurrente metió +300 → la base resuelve 1000+300+500 = 1800.
    ;(prisma.rawMaterial.findFirst as jest.Mock).mockResolvedValue(mockCafe(1000))
    ;(prisma.rawMaterial.update as jest.Mock).mockResolvedValue(mockCafe(1800))

    await adjustStock(VENUE_ID, RM_ID, { quantity: 500, type: RawMaterialMovementType.ADJUSTMENT } as any, 'staff-1')

    const movement = (prisma.rawMaterialMovement.create as jest.Mock).mock.calls[0][0]
    // Con la asignación absoluta esto salía 1000→1500 y el kardex perdía los
    // +300 concurrentes; el saldo real de la base habría quedado pisado también.
    expect(Number(movement.data.previousStock)).toBe(1300)
    expect(Number(movement.data.newStock)).toBe(1800)
  })
})
