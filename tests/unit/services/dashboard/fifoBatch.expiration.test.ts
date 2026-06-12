/**
 * Regression tests — expiración y cuarentena de lotes FIFO.
 *
 * Bug (auditoría FIFO 2026-06-11): markExpiredBatches y quarantineBatch solo
 * cambiaban el status del lote. El remainingQuantity salía de circulación FIFO
 * (deductStockFIFO solo consume lotes ACTIVE) pero RawMaterial.currentStock NO
 * se descontaba → el dashboard mostraba stock que ya no existía y las ventas
 * fallaban con "Insufficient stock" pese a stock aparente.
 *
 * Estos tests fallan con el código roto y pasan con el fix: al expirar o
 * cuarentenar, currentStock baja por el remainingQuantity y queda un
 * movimiento SPOILAGE con la cantidad real (no 0).
 */

import prisma from '@/utils/prismaClient'
import { markExpiredBatches, quarantineBatch } from '@/services/dashboard/fifoBatch.service'
import { Decimal } from '@prisma/client/runtime/library'
import { BatchStatus, RawMaterialMovementType } from '@prisma/client'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    stockBatch: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    rawMaterial: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    rawMaterialMovement: { create: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn(),
}))

const mockedPrisma = prisma as unknown as Record<string, Record<string, jest.Mock>> & { $transaction: jest.Mock }

const VENUE_ID = 'venue-1'
const RM_ID = 'rm-1'
const BATCH_ID = 'batch-1'

function makeBatch(overrides: Partial<any> = {}) {
  return {
    id: BATCH_ID,
    venueId: VENUE_ID,
    rawMaterialId: RM_ID,
    batchNumber: 'BATCH-20260601-001',
    status: BatchStatus.ACTIVE,
    initialQuantity: new Decimal(500),
    remainingQuantity: new Decimal(300),
    unit: 'GRAM',
    costPerUnit: new Decimal(0.01),
    receivedDate: new Date('2026-06-01'),
    expirationDate: new Date('2026-06-08'),
    rawMaterial: { id: RM_ID, name: 'Harina', unit: 'GRAM', currentStock: new Decimal(1000) },
    ...overrides,
  }
}

function wireTransaction() {
  mockedPrisma.$transaction.mockImplementation(async (cb: (tx: any) => Promise<any>) => {
    const tx = {
      stockBatch: mockedPrisma.stockBatch,
      rawMaterial: mockedPrisma.rawMaterial,
      rawMaterialMovement: mockedPrisma.rawMaterialMovement,
    }
    return cb(tx)
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  wireTransaction()
  mockedPrisma.rawMaterial.findUnique.mockResolvedValue({ id: RM_ID, name: 'Harina', unit: 'GRAM', currentStock: new Decimal(1000) })
  mockedPrisma.rawMaterial.update.mockResolvedValue({})
  mockedPrisma.rawMaterialMovement.create.mockResolvedValue({})
  mockedPrisma.stockBatch.update.mockImplementation(async ({ data }: any) => ({
    ...makeBatch(),
    ...data,
    rawMaterial: makeBatch().rawMaterial,
  }))
  mockedPrisma.stockBatch.updateMany.mockResolvedValue({ count: 1 })
})

describe('markExpiredBatches — el stock caducado sale del inventario', () => {
  it('marca EXPIRED, descuenta currentStock por el remanente y crea movimiento SPOILAGE negativo', async () => {
    const batch = makeBatch()
    mockedPrisma.stockBatch.findMany.mockResolvedValue([batch])
    mockedPrisma.stockBatch.findUnique.mockResolvedValue({ remainingQuantity: batch.remainingQuantity })

    const count = await markExpiredBatches(VENUE_ID)

    expect(count).toBe(1)

    // currentStock: 1000 − 300 = 700
    expect(mockedPrisma.rawMaterial.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: RM_ID } }))
    const stockArg = mockedPrisma.rawMaterial.update.mock.calls[0][0].data.currentStock
    expect(new Decimal(stockArg).toNumber()).toBe(700)

    // Movimiento SPOILAGE con la cantidad real (negativa), no 0
    expect(mockedPrisma.rawMaterialMovement.create).toHaveBeenCalledTimes(1)
    const movement = mockedPrisma.rawMaterialMovement.create.mock.calls[0][0].data
    expect(movement.type).toBe(RawMaterialMovementType.SPOILAGE)
    expect(new Decimal(movement.quantity).toNumber()).toBe(-300)
    expect(movement.batchId).toBe(BATCH_ID)
  })

  it('no descuenta nada si otro proceso ya expiró el lote (claim condicional)', async () => {
    mockedPrisma.stockBatch.findMany.mockResolvedValue([makeBatch()])
    mockedPrisma.stockBatch.updateMany.mockResolvedValue({ count: 0 })

    const count = await markExpiredBatches(VENUE_ID)

    expect(count).toBe(0)
    expect(mockedPrisma.rawMaterial.update).not.toHaveBeenCalled()
    expect(mockedPrisma.rawMaterialMovement.create).not.toHaveBeenCalled()
  })
})

describe('quarantineBatch — cuarentenar saca el remanente del inventario', () => {
  it('marca QUARANTINED, descuenta currentStock y crea movimiento SPOILAGE con la cantidad real', async () => {
    const batch = makeBatch({ remainingQuantity: new Decimal(200) })
    mockedPrisma.stockBatch.findFirst.mockResolvedValue(batch)
    mockedPrisma.stockBatch.findUnique.mockResolvedValue({ remainingQuantity: batch.remainingQuantity })

    await quarantineBatch(VENUE_ID, BATCH_ID, 'Producto dañado')

    // currentStock: 1000 − 200 = 800
    const stockArg = mockedPrisma.rawMaterial.update.mock.calls[0][0].data.currentStock
    expect(new Decimal(stockArg).toNumber()).toBe(800)

    const movement = mockedPrisma.rawMaterialMovement.create.mock.calls[0][0].data
    expect(movement.type).toBe(RawMaterialMovementType.SPOILAGE)
    expect(new Decimal(movement.quantity).toNumber()).toBe(-200)
    expect(movement.batchId).toBe(BATCH_ID)
  })

  it('cuarentenar un lote ya agotado (remaining 0) no genera movimiento ni cambia stock', async () => {
    const batch = makeBatch({ remainingQuantity: new Decimal(0), status: BatchStatus.DEPLETED })
    mockedPrisma.stockBatch.findFirst.mockResolvedValue(batch)
    mockedPrisma.stockBatch.findUnique.mockResolvedValue({ remainingQuantity: new Decimal(0) })

    await quarantineBatch(VENUE_ID, BATCH_ID, 'Inspección')

    expect(mockedPrisma.rawMaterial.update).not.toHaveBeenCalled()
    expect(mockedPrisma.rawMaterialMovement.create).not.toHaveBeenCalled()
  })
})
