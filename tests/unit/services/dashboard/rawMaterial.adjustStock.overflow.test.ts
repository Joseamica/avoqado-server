/**
 * Regression tests — adjustStock: overflow de costImpact + atomicidad del batch.
 *
 * Bug (render-error-monitor 2026-07-23, firma #27): una MANAGER de Mindform
 * capturó un ajuste manual de "Hielo" de 100,000,000 g (typo, 3 ceros de más).
 * `costImpact = costPerUnit(0.01) × 100,000,000 = 1,000,000` NO cabe en
 * Decimal(10,4) → Postgres 22003 → 500. Pero `createStockBatch` corría FUERA de
 * la $transaction, así que el batch (BATCH-20260723-001, 100M g ACTIVE = $1M de
 * inventario fantasma) SOBREVIVIÓ al rollback.
 *
 * Fix (dos capas):
 *  1. Pre-check `|costPerUnit × quantity| < 1e6` ANTES de escribir nada → 400 claro.
 *  2. `createStockBatch` + update + movement corren en la MISMA $transaction
 *     interactiva → cualquier fallo posterior revierte el batch (sin huérfanos).
 */

import { Unit, RawMaterialMovementType } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { adjustStock, createRawMaterial } from '@/services/dashboard/rawMaterial.service'
import { createStockBatch } from '@/services/dashboard/fifoBatch.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/services/dashboard/fifoBatch.service', () => {
  const actual = jest.requireActual('@/services/dashboard/fifoBatch.service')
  return {
    ...actual,
    deductStockFIFO: jest.fn(),
    createStockBatch: jest.fn(),
  }
})

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    rawMaterial: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
    rawMaterialMovement: { create: jest.fn() },
    stockBatch: { create: jest.fn(), findFirst: jest.fn() },
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

const VENUE_ID = 'venue-mindform'
const RM_ID = 'rm-hielo'
const STAFF_ID = 'staff-anasofia'

/** RawMaterial "Hielo": stored in GRAM, cost $0.01/g — verbatim from the incident. */
function mockHielo(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: RM_ID,
    venueId: VENUE_ID,
    name: 'Hielo',
    unit: Unit.GRAM,
    currentStock: new Decimal(101140),
    reorderPoint: new Decimal(0),
    costPerUnit: new Decimal('0.01'),
    perishable: false,
    shelfLifeDays: null,
    lastCountAt: null,
    ...overrides,
  }
}

describe('adjustStock — costImpact overflow guard', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // $transaction(callback) pattern: invoke callback with the prisma mock as tx.
    ;(prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(prisma))
    ;(prisma.lowStockAlert.findFirst as jest.Mock).mockResolvedValue(null)
  })

  it('REGRESSION: rechaza el ajuste de 100,000,000 g ANTES de escribir nada (no batch huérfano)', async () => {
    ;(prisma.rawMaterial.findFirst as jest.Mock).mockResolvedValue(mockHielo())

    await expect(
      adjustStock(VENUE_ID, RM_ID, { quantity: 100_000_000, type: RawMaterialMovementType.ADJUSTMENT } as any, STAFF_ID),
    ).rejects.toMatchObject({ statusCode: 400 })

    // El punto del fix: NADA se escribió — ni batch, ni transacción.
    expect(createStockBatch).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(prisma.rawMaterialMovement.create).not.toHaveBeenCalled()
  })

  it('el mensaje del 400 está en español y menciona el impacto de costo', async () => {
    ;(prisma.rawMaterial.findFirst as jest.Mock).mockResolvedValue(mockHielo())

    await expect(
      adjustStock(VENUE_ID, RM_ID, { quantity: 100_000_000, type: RawMaterialMovementType.ADJUSTMENT } as any, STAFF_ID),
    ).rejects.toThrow(/impacto de costo/i)
  })

  it('rechaza exactamente en el límite (costImpact = 1,000,000 = tope de Decimal(10,4))', async () => {
    // costPerUnit 1 × quantity 1,000,000 = 1,000,000 → NO cabe (< 1e6 es el máx).
    ;(prisma.rawMaterial.findFirst as jest.Mock).mockResolvedValue(mockHielo({ costPerUnit: new Decimal('1') }))

    await expect(
      adjustStock(VENUE_ID, RM_ID, { quantity: 1_000_000, type: RawMaterialMovementType.ADJUSTMENT } as any, STAFF_ID),
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(createStockBatch).not.toHaveBeenCalled()
  })
})

describe('adjustStock — adición válida es atómica', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(prisma))
    ;(prisma.lowStockAlert.findFirst as jest.Mock).mockResolvedValue(null)
    ;(prisma.rawMaterial.findFirst as jest.Mock).mockResolvedValue(mockHielo())
    ;(createStockBatch as jest.Mock).mockResolvedValue({
      id: 'batch-ok',
      batchNumber: 'BATCH-20260723-002',
      costPerUnit: new Decimal('0.01'),
    })
    ;(prisma.rawMaterial.update as jest.Mock).mockResolvedValue(mockHielo({ currentStock: new Decimal(201140) }))
    ;(prisma.rawMaterialMovement.create as jest.Mock).mockResolvedValue({})
  })

  it('el reintento legítimo (100,000 g) crea el batch DENTRO de la transacción y con skipAudit', async () => {
    await adjustStock(VENUE_ID, RM_ID, { quantity: 100_000, type: RawMaterialMovementType.ADJUSTMENT } as any, STAFF_ID)

    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    // createStockBatch recibe el cliente tx (5º arg) y { skipAudit: true } (6º arg),
    // NO el prisma por default — así el batch se revierte si algo falla después.
    const call = (createStockBatch as jest.Mock).mock.calls[0]
    expect(call[3]).toBe(STAFF_ID)
    expect(call[4]).toBe(prisma) // tx (el mock recibe prisma como tx)
    expect(call[5]).toEqual({ skipAudit: true })
  })

  it('registra el movement con costImpact = 1,000 (0.01 × 100,000)', async () => {
    await adjustStock(VENUE_ID, RM_ID, { quantity: 100_000, type: RawMaterialMovementType.ADJUSTMENT } as any, STAFF_ID)

    const movement = (prisma.rawMaterialMovement.create as jest.Mock).mock.calls[0][0]
    expect(movement.data.batchId).toBe('batch-ok')
    expect(Number(movement.data.costImpact)).toBeCloseTo(1000, 4)
  })

  it('audita STOCK_BATCH_CREATED DESPUÉS del commit (no se pierde por el skipAudit interno)', async () => {
    await adjustStock(VENUE_ID, RM_ID, { quantity: 100_000, type: RawMaterialMovementType.ADJUSTMENT } as any, STAFF_ID)

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'STOCK_BATCH_CREATED',
        entity: 'StockBatch',
        entityId: 'batch-ok',
        data: expect.objectContaining({ batchNumber: 'BATCH-20260723-002', rawMaterialId: RM_ID, quantity: 100_000 }),
      }),
    )
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'STOCK_ADJUSTED', entityId: RM_ID }))
  })
})

describe('createRawMaterial — stock inicial atómico', () => {
  const CREATE_DTO = {
    name: 'Hielo',
    sku: 'HIELO-001',
    unit: Unit.GRAM,
    category: 'OTHER',
    currentStock: 5000,
    costPerUnit: 0.01,
    reorderPoint: 0,
    perishable: false,
    shelfLifeDays: null,
  }

  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(prisma))
    ;(prisma.rawMaterial.findFirst as jest.Mock).mockResolvedValue(null) // no SKU duplicado
    ;(prisma.rawMaterial.create as jest.Mock).mockResolvedValue({ id: 'rm-new', name: 'Hielo' })
    ;(createStockBatch as jest.Mock).mockResolvedValue({
      id: 'batch-init',
      batchNumber: 'BATCH-20260723-001',
      costPerUnit: new Decimal('0.01'),
    })
    ;(prisma.rawMaterialMovement.create as jest.Mock).mockResolvedValue({})
  })

  it('crea RM + batch inicial + movement DENTRO de una sola transacción', async () => {
    await createRawMaterial(VENUE_ID, CREATE_DTO as any)

    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    // createStockBatch corre con el cliente tx y skipAudit — antes corría fuera de tx.
    const call = (createStockBatch as jest.Mock).mock.calls[0]
    expect(call[4]).toBe(prisma) // tx
    expect(call[5]).toEqual({ skipAudit: true })
    // El movement de stock inicial se registra con la cantidad correcta.
    const movement = (prisma.rawMaterialMovement.create as jest.Mock).mock.calls[0][0]
    expect(movement.data.batchId).toBe('batch-init')
    expect(Number(movement.data.newStock)).toBe(5000)
  })

  it('audita STOCK_BATCH_CREATED (después del commit) y RAW_MATERIAL_CREATED', async () => {
    await createRawMaterial(VENUE_ID, CREATE_DTO as any)

    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'STOCK_BATCH_CREATED', entityId: 'batch-init' }))
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'RAW_MATERIAL_CREATED', entityId: 'rm-new' }))
  })

  it('sin stock inicial (currentStock 0): no crea batch ni movement, pero sí el RM', async () => {
    await createRawMaterial(VENUE_ID, { ...CREATE_DTO, currentStock: 0 } as any)

    expect(createStockBatch).not.toHaveBeenCalled()
    expect(prisma.rawMaterialMovement.create).not.toHaveBeenCalled()
    expect(prisma.rawMaterial.create).toHaveBeenCalledTimes(1)
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'RAW_MATERIAL_CREATED', entityId: 'rm-new' }))
  })
})
