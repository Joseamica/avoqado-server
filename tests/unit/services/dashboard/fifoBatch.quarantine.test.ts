/**
 * Quarantine warehouse: putting a batch on hold and — the part that was missing — being
 * able to release it.
 *
 * `quarantineBatch` had been written, tested and COMPLETELY UNREACHABLE for a long time:
 * not a single route, controller or MCP tool called it. And it was missing half of the
 * cycle: there was no way to release. Holding a batch was a one-way trip and the only way
 * out was editing the database by hand.
 *
 * A quality hold is temporary by definition: you hold it, somebody reviews it, and it
 * either gets released or written off. A quarantine warehouse with no exit is not a
 * warehouse, it is a hole.
 *
 * THE INVARIANT these tests protect:
 *     currentStock === Σ remainingQuantity of the ACTIVE batches
 * A held batch is not ACTIVE, so it contributes 0. Releasing it contributes its remainder,
 * and the aggregate has to go up by exactly that — no more, no less, and not twice.
 */

import prisma from '@/utils/prismaClient'
import { quarantineBatch, releaseBatchFromQuarantine } from '@/services/dashboard/fifoBatch.service'
import { Decimal } from '@prisma/client/runtime/library'
import { BatchStatus, RawMaterialMovementType } from '@prisma/client'
import AppError from '@/errors/AppError'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    stockBatch: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    rawMaterial: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    rawMaterialMovement: { create: jest.fn() },
    $transaction: jest.fn(),
  },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import { logAction } from '@/services/dashboard/activity-log.service'

const mockedPrisma = prisma as unknown as Record<string, Record<string, jest.Mock>> & { $transaction: jest.Mock }

const VENUE = 'venue-1'
const RM = 'rm-1'
const BATCH = 'batch-1'
const STAFF = 'staff-almacen'
const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000)
const NEXT_MONTH = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

function batch(over: Partial<any> = {}) {
  return {
    id: BATCH,
    venueId: VENUE,
    rawMaterialId: RM,
    batchNumber: 'BATCH-20260601-001',
    status: BatchStatus.QUARANTINED,
    initialQuantity: new Decimal(500),
    remainingQuantity: new Decimal(300),
    unit: 'GRAM',
    costPerUnit: new Decimal(0.01),
    receivedDate: new Date('2026-06-01'),
    expirationDate: NEXT_MONTH,
    rawMaterial: { id: RM, name: 'Harina', unit: 'GRAM', currentStock: new Decimal(700) },
    ...over,
  }
}

function wireTransaction() {
  mockedPrisma.$transaction.mockImplementation(async (cb: (tx: any) => Promise<any>) =>
    cb({
      stockBatch: mockedPrisma.stockBatch,
      rawMaterial: mockedPrisma.rawMaterial,
      rawMaterialMovement: mockedPrisma.rawMaterialMovement,
    }),
  )
}

const writtenStatus = () => mockedPrisma.stockBatch.update.mock.calls[0]?.[0]?.data?.status
const writtenStock = () => new Decimal(mockedPrisma.rawMaterial.update.mock.calls[0][0].data.currentStock).toNumber()
const movement = () => mockedPrisma.rawMaterialMovement.create.mock.calls[0][0].data

beforeEach(() => {
  jest.clearAllMocks()
  wireTransaction()
  mockedPrisma.rawMaterial.update.mockResolvedValue({})
  mockedPrisma.rawMaterialMovement.create.mockResolvedValue({})
  mockedPrisma.stockBatch.update.mockImplementation(async ({ data }: any) => ({ ...batch(), ...data, rawMaterial: batch().rawMaterial }))
})

describe('releasing a held batch', () => {
  it('🔴 puts it back to ACTIVE and returns its remainder to available stock', async () => {
    mockedPrisma.stockBatch.findFirst.mockResolvedValue(batch())
    mockedPrisma.stockBatch.findUnique.mockResolvedValue({
      remainingQuantity: new Decimal(300),
      expirationDate: NEXT_MONTH,
      status: BatchStatus.QUARANTINED,
    })

    await releaseBatchFromQuarantine(VENUE, BATCH, 'El proveedor mandó el certificado de calidad', STAFF)

    expect(writtenStatus()).toBe(BatchStatus.ACTIVE)
    expect(writtenStock()).toBe(1000) // 700 + 300
  })

  it('leaves a positive movement carrying the reason, so the stock ledger balances', async () => {
    mockedPrisma.stockBatch.findFirst.mockResolvedValue(batch())
    mockedPrisma.stockBatch.findUnique.mockResolvedValue({
      remainingQuantity: new Decimal(300),
      expirationDate: NEXT_MONTH,
      status: BatchStatus.QUARANTINED,
    })

    await releaseBatchFromQuarantine(VENUE, BATCH, 'Certificado recibido', STAFF)

    expect(movement().type).toBe(RawMaterialMovementType.ADJUSTMENT)
    expect(new Decimal(movement().quantity).toNumber()).toBe(300)
    expect(movement().reason).toContain('Certificado recibido')
    expect(movement().batchId).toBe(BATCH)
  })

  it('🔴 a batch that expired while on hold does NOT go back into inventory', async () => {
    // The worst possible ending for this function would be releasing expired goods back
    // into circulation because whoever released them did not look at the date. The status
    // is decided by the batch's reality, not by whoever releases it.
    mockedPrisma.stockBatch.findFirst.mockResolvedValue(batch({ expirationDate: YESTERDAY }))
    mockedPrisma.stockBatch.findUnique.mockResolvedValue({
      remainingQuantity: new Decimal(300),
      expirationDate: YESTERDAY,
      status: BatchStatus.QUARANTINED,
    })

    await releaseBatchFromQuarantine(VENUE, BATCH, 'Ya se revisó', STAFF)

    expect(writtenStatus()).toBe(BatchStatus.EXPIRED)
    expect(mockedPrisma.rawMaterial.update).not.toHaveBeenCalled()
    expect(mockedPrisma.rawMaterialMovement.create).not.toHaveBeenCalled()
  })

  it('a batch with no remainder comes back as DEPLETED and adds nothing', async () => {
    mockedPrisma.stockBatch.findFirst.mockResolvedValue(batch({ remainingQuantity: new Decimal(0) }))
    mockedPrisma.stockBatch.findUnique.mockResolvedValue({
      remainingQuantity: new Decimal(0),
      expirationDate: NEXT_MONTH,
      status: BatchStatus.QUARANTINED,
    })

    await releaseBatchFromQuarantine(VENUE, BATCH, 'revisado', STAFF)

    expect(writtenStatus()).toBe(BatchStatus.DEPLETED)
    expect(mockedPrisma.rawMaterial.update).not.toHaveBeenCalled()
  })

  it('🔴 re-reads inside the transaction: if someone else released it first, it does not add twice', async () => {
    // Without this re-read, two simultaneous releases would add the remainder TWICE to
    // available stock. It is exactly the same kind of leak that already cost us money in
    // purchase receiving.
    mockedPrisma.stockBatch.findFirst.mockResolvedValue(batch())
    mockedPrisma.stockBatch.findUnique.mockResolvedValue({
      remainingQuantity: new Decimal(300),
      expirationDate: NEXT_MONTH,
      status: BatchStatus.ACTIVE, // somebody else already released it between the read and the tx
    })

    await expect(releaseBatchFromQuarantine(VENUE, BATCH, 'motivo', STAFF)).rejects.toMatchObject({ statusCode: 409 })
    expect(mockedPrisma.rawMaterial.update).not.toHaveBeenCalled()
  })

  it('does not release a batch that is not on hold', async () => {
    mockedPrisma.stockBatch.findFirst.mockResolvedValue(batch({ status: BatchStatus.ACTIVE }))

    await expect(releaseBatchFromQuarantine(VENUE, BATCH, 'motivo', STAFF)).rejects.toThrow(AppError)
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled()
  })

  it('demands a reason: without one there is nothing to audit', async () => {
    mockedPrisma.stockBatch.findFirst.mockResolvedValue(batch())

    for (const blank of ['', '   ']) {
      await expect(releaseBatchFromQuarantine(VENUE, BATCH, blank, STAFF)).rejects.toThrow(AppError)
    }
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled()
  })

  it('TENANT: only looks for batches belonging to the venue in the request', async () => {
    mockedPrisma.stockBatch.findFirst.mockResolvedValue(null)

    await expect(releaseBatchFromQuarantine(VENUE, BATCH, 'motivo', STAFF)).rejects.toMatchObject({ statusCode: 404 })
    expect(mockedPrisma.stockBatch.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: BATCH, venueId: VENUE } }))
  })

  it("writes the owner's audit trail with the actor and the resulting status", async () => {
    mockedPrisma.stockBatch.findFirst.mockResolvedValue(batch())
    mockedPrisma.stockBatch.findUnique.mockResolvedValue({
      remainingQuantity: new Decimal(300),
      expirationDate: NEXT_MONTH,
      status: BatchStatus.QUARANTINED,
    })

    await releaseBatchFromQuarantine(VENUE, BATCH, 'certificado ok', STAFF)

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'STOCK_BATCH_RELEASED',
        staffId: STAFF,
        venueId: VENUE,
        data: expect.objectContaining({ estadoResultante: BatchStatus.ACTIVE, regresoAlInventario: true }),
      }),
    )
  })
})

describe('holding: what got hardened once it was exposed', () => {
  it('🔴 demands a reason — holding goods "just because" is not auditable', async () => {
    mockedPrisma.stockBatch.findFirst.mockResolvedValue(batch({ status: BatchStatus.ACTIVE }))

    for (const blank of ['', '   ']) {
      await expect(quarantineBatch(VENUE, BATCH, blank, STAFF)).rejects.toThrow(AppError)
    }
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled()
  })

  it('🔴 a batch is not held twice', async () => {
    // It would not deduct twice (`wasActive` protects that), but it would leave a SECOND
    // audit row with a different reason on top of a hold that already existed, and whoever
    // audits it would believe there had been two separate events.
    mockedPrisma.stockBatch.findFirst.mockResolvedValue(batch({ status: BatchStatus.QUARANTINED }))

    await expect(quarantineBatch(VENUE, BATCH, 'otra vez', STAFF)).rejects.toMatchObject({ statusCode: 409 })
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled()
  })

  it('REGRESSION: holding an active batch still deducts its remainder', async () => {
    mockedPrisma.stockBatch.findFirst.mockResolvedValue(batch({ status: BatchStatus.ACTIVE }))
    mockedPrisma.stockBatch.findUnique.mockResolvedValue({ remainingQuantity: new Decimal(300) })

    await quarantineBatch(VENUE, BATCH, 'Empaque dañado en la recepción', STAFF)

    expect(writtenStatus()).toBe(BatchStatus.QUARANTINED)
    expect(writtenStock()).toBe(400) // 700 − 300
    expect(movement().type).toBe(RawMaterialMovementType.SPOILAGE)
    expect(new Decimal(movement().quantity).toNumber()).toBe(-300)
  })

  it('the reason reaches the movement and the audit trail trimmed', async () => {
    mockedPrisma.stockBatch.findFirst.mockResolvedValue(batch({ status: BatchStatus.ACTIVE }))
    mockedPrisma.stockBatch.findUnique.mockResolvedValue({ remainingQuantity: new Decimal(300) })

    await quarantineBatch(VENUE, BATCH, '   Empaque dañado   ', STAFF)

    expect(movement().reason).toBe('Lote retenido: Empaque dañado')
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ reason: 'Empaque dañado' }) }))
  })
})

describe('holding and releasing are symmetric', () => {
  it('🔴 available stock lands back exactly where it started', async () => {
    // This is the test that really matters: if holding deducts 300 and releasing gives back
    // 299 or 301, inventory silently degrades with every single hold.
    mockedPrisma.stockBatch.findFirst.mockResolvedValue(batch({ status: BatchStatus.ACTIVE, rawMaterial: { ...batch().rawMaterial } }))
    mockedPrisma.stockBatch.findUnique.mockResolvedValue({ remainingQuantity: new Decimal(300) })

    await quarantineBatch(VENUE, BATCH, 'sospecha de plaga', STAFF)
    const afterHolding = writtenStock() // 700 − 300 = 400

    jest.clearAllMocks()
    wireTransaction()
    mockedPrisma.rawMaterial.update.mockResolvedValue({})
    mockedPrisma.rawMaterialMovement.create.mockResolvedValue({})
    // The raw material already carries the available stock ALREADY deducted by the hold:
    // that is the real state the release starts from.
    const materialAfterHolding = { ...batch().rawMaterial, currentStock: new Decimal(afterHolding) }
    mockedPrisma.stockBatch.update.mockImplementation(async ({ data }: any) => ({
      ...batch(),
      ...data,
      rawMaterial: materialAfterHolding,
    }))
    mockedPrisma.stockBatch.findFirst.mockResolvedValue(batch({ status: BatchStatus.QUARANTINED, rawMaterial: materialAfterHolding }))
    mockedPrisma.stockBatch.findUnique.mockResolvedValue({
      remainingQuantity: new Decimal(300),
      expirationDate: NEXT_MONTH,
      status: BatchStatus.QUARANTINED,
    })

    await releaseBatchFromQuarantine(VENUE, BATCH, 'fumigado y liberado', STAFF)

    expect(afterHolding).toBe(400)
    expect(writtenStock()).toBe(700) // exactly the starting point
  })
})
