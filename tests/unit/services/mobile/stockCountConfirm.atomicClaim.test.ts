/**
 * confirmStockCount — claim atómico + SET dentro de tx con relectura (fase 3).
 *
 * Dos defectos corregidos:
 *
 * 1. DOBLE-CONFIRM: dos confirmaciones concurrentes pasaban ambas el check de
 *    status (leído fuera de toda transacción) y aplicaban los ajustes DOS
 *    veces (movimientos COUNT duplicados). Fix: claim atómico
 *    IN_PROGRESS→COMPLETED vía updateMany condicional; solo quien gana el
 *    claim aplica.
 *
 * 2. TOCTOU: el delta se calculaba contra el snapshot cargado al ABRIR la
 *    confirmación; una venta en la ventana quedaba pisada por el SET y el
 *    movimiento guardaba un previousStock mentiroso. Fix: cada línea relee el
 *    stock DENTRO de su transacción con FOR UPDATE y el SET/delta se calculan
 *    contra ese valor fresco.
 */

import { Decimal } from '@prisma/client/runtime/library'
import { prismaMock } from '../../../__helpers__/setup'
import { confirmStockCount } from '@/services/mobile/inventory.mobile.service'
import { createStockBatch, deductStockFIFOInTx } from '@/services/dashboard/fifoBatch.service'

jest.mock('@/services/dashboard/fifoBatch.service', () => {
  const actual = jest.requireActual('@/services/dashboard/fifoBatch.service')
  return {
    ...actual,
    createStockBatch: jest.fn(),
    deductStockFIFOInTx: jest.fn(),
  }
})

jest.mock('@/services/dashboard/rawMaterial.service', () => {
  const actual = jest.requireActual('@/services/dashboard/rawMaterial.service')
  return {
    ...actual,
    adjustStock: jest.fn(),
    checkAndCreateLowStockAlert: jest.fn(),
  }
})

const COUNT_ID = 'count-1'
const VENUE_ID = 'venue-1'
const USER_ID = 'staff-1'

const productItem = (opts: { counted: number; snapshotStock: number }) => ({
  id: 'item-prod',
  productId: 'prod-1',
  rawMaterialId: null,
  rawMaterial: null,
  expected: 89,
  counted: opts.counted,
  countedAt: new Date(),
  product: {
    id: 'prod-1',
    name: 'Cerveza Corona',
    inventory: { id: 'inv-1', currentStock: opts.snapshotStock },
  },
})

const ingredientItem = (opts: { counted: number; snapshotStock: number }) => ({
  id: 'item-ing',
  productId: null,
  product: null,
  rawMaterialId: 'rm-1',
  rawMaterial: { id: 'rm-1', name: 'Harina', currentStock: new Decimal(opts.snapshotStock), unit: 'GRAM' },
  expected: 10,
  counted: opts.counted,
  countedAt: new Date(),
})

const armarConteo = (items: any[]) => {
  prismaMock.stockCount.findFirst.mockResolvedValue({ id: COUNT_ID, venueId: VENUE_ID, status: 'IN_PROGRESS', items } as any)
}

describe('confirmStockCount — claim atómico y relectura en tx', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (arg: any) => (typeof arg === 'function' ? arg(prismaMock) : Promise.all(arg)))
    prismaMock.stockCount.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.stockCount.update.mockResolvedValue({})
    prismaMock.inventory.update.mockResolvedValue({})
    prismaMock.inventoryMovement.create.mockResolvedValue({})
    prismaMock.rawMaterial.update.mockResolvedValue({})
    prismaMock.rawMaterialMovement.create.mockResolvedValue({})
  })

  it('quien PIERDE el claim (updateMany count 0) no aplica NINGÚN ajuste', async () => {
    armarConteo([productItem({ counted: 89, snapshotStock: 32 })])
    prismaMock.stockCount.updateMany.mockResolvedValue({ count: 0 })
    prismaMock.$queryRaw.mockResolvedValue([{ currentStock: 32 }])

    await expect(confirmStockCount(COUNT_ID, VENUE_ID, USER_ID)).rejects.toThrow(/no encontrado|completado/i)

    expect(prismaMock.inventory.update).not.toHaveBeenCalled()
    expect(prismaMock.inventoryMovement.create).not.toHaveBeenCalled()
  })

  it('el claim es condicional y reclama APPLYING (no COMPLETED): completar se gana aplicando', async () => {
    armarConteo([productItem({ counted: 32, snapshotStock: 32 })])
    prismaMock.$queryRaw.mockResolvedValue([{ currentStock: 32 }])

    await confirmStockCount(COUNT_ID, VENUE_ID, USER_ID)

    const claimArgs = prismaMock.stockCount.updateMany.mock.calls[0][0] as any
    expect(claimArgs.where).toMatchObject({ id: COUNT_ID, venueId: VENUE_ID })
    // El claim acepta IN_PROGRESS o un APPLYING huérfano con lease vencido.
    const statuses = claimArgs.where.OR.map((c: any) => c.status)
    expect(statuses).toContain('IN_PROGRESS')
    expect(statuses).toContain('APPLYING')
    // 🔴 El claim marca APPLYING, jamás COMPLETED: un crash a media aplicación
    // dejaba antes un conteo "completado" con cero ajustes y sin reintento.
    expect(claimArgs.data.status).toBe('APPLYING')
  })

  it('🔴 COMPLETED se estampa AL FINAL, después de aplicar todos los ajustes', async () => {
    armarConteo([productItem({ counted: 30, snapshotStock: 32 })])
    prismaMock.$queryRaw.mockResolvedValue([{ currentStock: 32 }])

    await confirmStockCount(COUNT_ID, VENUE_ID, USER_ID)

    const completedCall = prismaMock.stockCount.update.mock.calls.find((c: any[]) => c[0]?.data?.status === 'COMPLETED')
    expect(completedCall).toBeDefined()
    expect(completedCall![0].data).toMatchObject({ status: 'COMPLETED', applyingAt: null })
    // Y ocurre DESPUÉS de aplicar el ajuste (si no, no protege nada).
    const completeOrder = prismaMock.stockCount.update.mock.invocationCallOrder.slice(-1)[0]
    const applyOrder = prismaMock.inventoryMovement.create.mock.invocationCallOrder[0]
    expect(applyOrder).toBeLessThan(completeOrder)
  })

  it('un APPLYING huérfano (lease vencido) se puede re-reclamar: el conteo físico no se pierde', async () => {
    // El pre-read acepta APPLYING para poder cargar el conteo del worker muerto.
    prismaMock.stockCount.findFirst.mockResolvedValue({
      id: COUNT_ID,
      venueId: VENUE_ID,
      status: 'APPLYING',
      items: [productItem({ counted: 32, snapshotStock: 32 })],
    } as any)
    prismaMock.$queryRaw.mockResolvedValue([{ currentStock: 32 }])

    await confirmStockCount(COUNT_ID, VENUE_ID, USER_ID)

    const claimArgs = prismaMock.stockCount.updateMany.mock.calls[0][0] as any
    const staleClause = claimArgs.where.OR.find((c: any) => c.status === 'APPLYING')
    expect(staleClause.applyingAt.lt).toBeInstanceOf(Date)
    expect(staleClause.applyingAt.lt.getTime()).toBeLessThan(Date.now())
  })

  it('TOCTOU producto: el SET y el movimiento usan la relectura FOR UPDATE, no el snapshot', async () => {
    // Snapshot al abrir la confirmación: 89. Una venta concurrente lo bajó a 32
    // antes de aplicar; la relectura dentro de la tx ve 32.
    armarConteo([productItem({ counted: 30, snapshotStock: 89 })])
    prismaMock.$queryRaw.mockResolvedValue([{ currentStock: 32 }])

    await confirmStockCount(COUNT_ID, VENUE_ID, USER_ID)

    const movement = prismaMock.inventoryMovement.create.mock.calls[0][0]
    expect(Number(movement.data.previousStock)).toBe(32) // no 89
    expect(Number(movement.data.newStock)).toBe(30)
    expect(Number(movement.data.quantity)).toBe(-2) // no −59
  })

  it('TOCTOU insumo (delta positivo): lote + SET usan la relectura, dentro de la MISMA tx', async () => {
    // Snapshot: 10. La relectura fresca ve 7 (ventas en la ventana). Contado: 9.
    armarConteo([ingredientItem({ counted: 9, snapshotStock: 10 })])
    prismaMock.$queryRaw.mockResolvedValue([
      { currentStock: new Decimal(7), unit: 'GRAM', costPerUnit: new Decimal('0.05'), perishable: false, shelfLifeDays: null },
    ])
    ;(createStockBatch as jest.Mock).mockResolvedValue({ id: 'batch-1', batchNumber: 'B-1', costPerUnit: new Decimal('0.05') })

    await confirmStockCount(COUNT_ID, VENUE_ID, USER_ID)

    // El lote del excedente se crea con el cliente tx y skipAudit.
    const batchCall = (createStockBatch as jest.Mock).mock.calls[0]
    expect(batchCall[4]).toBe(prismaMock)
    expect(batchCall[5]).toEqual({ skipAudit: true })
    // El movimiento COUNT registra el delta REAL (7 → 9), no el del snapshot (10 → 9).
    const movement = prismaMock.rawMaterialMovement.create.mock.calls[0][0]
    expect(Number(movement.data.previousStock)).toBe(7)
    expect(Number(movement.data.newStock)).toBe(9)
    expect(Number(movement.data.quantity)).toBe(2)
  })

  it('insumo con delta negativo deduce por FIFO dentro de la tx (deductStockFIFOInTx)', async () => {
    armarConteo([ingredientItem({ counted: 5, snapshotStock: 10 })])
    prismaMock.$queryRaw.mockResolvedValue([
      { currentStock: new Decimal(8), unit: 'GRAM', costPerUnit: new Decimal('0.05'), perishable: false, shelfLifeDays: null },
    ])
    ;(deductStockFIFOInTx as jest.Mock).mockResolvedValue([])

    await confirmStockCount(COUNT_ID, VENUE_ID, USER_ID)

    expect(deductStockFIFOInTx).toHaveBeenCalledWith(
      prismaMock, // tx
      VENUE_ID,
      'rm-1',
      3, // |5 − 8| contra la relectura, no |5 − 10| contra el snapshot
      'COUNT',
      expect.objectContaining({ createdBy: USER_ID }),
    )
  })

  it('si la aplicación truena, el claim se REVIERTE a IN_PROGRESS para poder reintentar', async () => {
    armarConteo([ingredientItem({ counted: 5, snapshotStock: 10 })])
    // La relectura revienta con un error inesperado (no "sin lotes").
    prismaMock.$queryRaw.mockRejectedValue(new Error('connection reset'))

    await expect(confirmStockCount(COUNT_ID, VENUE_ID, USER_ID)).rejects.toThrow()

    expect(prismaMock.stockCount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: COUNT_ID },
        data: expect.objectContaining({ status: 'IN_PROGRESS' }),
      }),
    )
  })
})
