/**
 * Tests: InventoryPosting — el outbox durable de deducciones (fase 2 del plan
 * de inventario, auditoría 2026-08-12 + diseño Codex).
 *
 * Contrato:
 *  - `createSalePostingInTx` nace EN la transacción que marca la venta PAID,
 *    con una línea por item DEDUCIBLE (producto con tracking o con
 *    modificadores inventariables). Idempotente: el UNIQUE
 *    (venueId,sourceKind,sourceId,effectKind) hace que un segundo intento
 *    devuelva el posting existente en vez de duplicar.
 *  - `applySalePosting` reclama con CAS (PENDING/PARTIAL_FAILED → APPLYING),
 *    aplica línea por línea y es REINTENTABLE: una línea fallida se reintenta
 *    sin re-deducir las que ya aplicaron. Deja el kardex ligado por
 *    postingLineId. El negativo es diseño (Square-parity), no fallo.
 */

import { Prisma } from '@prisma/client'
import { prismaMock } from '../../../__helpers__/setup'

const deductInventoryMock = jest.fn()
const getInventoryMethodMock = jest.fn()
jest.mock('@/services/dashboard/productInventoryIntegration.service', () => ({
  deductInventoryForProduct: (...args: unknown[]) => deductInventoryMock(...args),
  getProductInventoryMethod: (...args: unknown[]) => getInventoryMethodMock(...args),
}))

import { applySalePosting, createSalePostingInTx } from '@/services/inventory/inventoryPosting.service'

const VENUE = 'venue-1'
const ORDER = 'order-1'

describe('createSalePostingInTx', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    getInventoryMethodMock.mockResolvedValue('QUANTITY')
  })

  const items = [
    { id: 'oi-1', productId: 'p1', quantity: 2, weightQuantity: null, modifiers: [] },
    { id: 'oi-2', productId: null, productName: 'Importe custom', quantity: 1, weightQuantity: null, modifiers: [] },
    { id: 'oi-3', productId: 'p3', quantity: 1, weightQuantity: new Prisma.Decimal('0.435'), modifiers: [] },
  ]

  it('crea el posting con una línea por item deducible (custom sin tracking queda fuera)', async () => {
    prismaMock.inventoryPosting.create.mockResolvedValue({ id: 'post-1', status: 'PENDING' } as any)

    const posting = await createSalePostingInTx(prismaMock as any, {
      venueId: VENUE,
      orderId: ORDER,
      items: items as any,
      staffId: 'staff-1',
    })

    expect(posting).toMatchObject({ id: 'post-1' })
    const createArg = prismaMock.inventoryPosting.create.mock.calls[0][0] as any
    expect(createArg.data.venueId).toBe(VENUE)
    expect(createArg.data.sourceKind).toBe('ORDER')
    expect(createArg.data.sourceId).toBe(ORDER)
    expect(createArg.data.effectKind).toBe('SALE')
    const lines = createArg.data.lines.create
    expect(lines).toHaveLength(2)
    // La línea de peso usa los KILOS como cantidad base, no quantity.
    expect(lines.find((l: any) => l.effectKey === 'oi-3').expectedQuantityBase.toString()).toBe('0.435')
    expect(lines.find((l: any) => l.effectKey === 'oi-1').expectedQuantityBase.toString()).toBe('2')
  })

  it('sin items deducibles crea el posting SKIPPED con razón durable NO_ITEMS', async () => {
    getInventoryMethodMock.mockResolvedValue(null)
    prismaMock.inventoryPosting.create.mockResolvedValue({ id: 'post-2', status: 'SKIPPED' } as any)

    await createSalePostingInTx(prismaMock as any, {
      venueId: VENUE,
      orderId: ORDER,
      items: [items[1]] as any,
      staffId: 'staff-1',
    })

    const createArg = prismaMock.inventoryPosting.create.mock.calls[0][0] as any
    expect(createArg.data.status).toBe('SKIPPED')
    expect(createArg.data.skipReason).toBe('NO_ITEMS')
  })

  it('el duplicado (P2002 del UNIQUE) devuelve el posting existente sin tronar', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' } as any)
    prismaMock.inventoryPosting.create.mockRejectedValue(p2002)
    prismaMock.inventoryPosting.findUnique.mockResolvedValue({ id: 'post-existente', status: 'APPLIED' } as any)

    const posting = await createSalePostingInTx(prismaMock as any, {
      venueId: VENUE,
      orderId: ORDER,
      items: items as any,
      staffId: 'staff-1',
    })

    expect(posting).toMatchObject({ id: 'post-existente' })
  })
})

describe('applySalePosting', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    getInventoryMethodMock.mockResolvedValue('QUANTITY')
    prismaMock.inventoryPosting.updateMany.mockResolvedValue({ count: 1 } as any)
    prismaMock.inventoryPostingLine.update.mockResolvedValue({} as any)
    prismaMock.inventoryPosting.update.mockResolvedValue({} as any)
  })

  const posting = (lines: any[]) => ({
    id: 'post-1',
    venueId: VENUE,
    orderId: ORDER,
    sourceId: ORDER,
    status: 'PENDING',
    attempts: 0,
    lines,
  })

  const line = (over: Record<string, unknown> = {}) => ({
    id: 'line-1',
    effectKey: 'oi-1',
    orderItemId: 'oi-1',
    productId: 'p1',
    status: 'PENDING',
    expectedQuantityBase: new Prisma.Decimal(2),
    ...over,
  })

  const wireOrderItems = (items: any[]) => {
    prismaMock.orderItem.findMany.mockResolvedValue(items as any)
  }

  it('aplica todas las líneas y deja el posting APPLIED con el kardex ligado', async () => {
    prismaMock.inventoryPosting.findUnique.mockResolvedValue(posting([line()]) as any)
    wireOrderItems([{ id: 'oi-1', productId: 'p1', quantity: 2, weightQuantity: null, modifiers: [] }])
    deductInventoryMock.mockResolvedValue({ inventoryMethod: 'QUANTITY', remainingStock: 5, productName: 'Coca' })

    const result = await applySalePosting('post-1', 'staff-1')

    expect(deductInventoryMock).toHaveBeenCalledWith(VENUE, 'p1', 2, ORDER, 'staff-1', [], expect.objectContaining({ postingLineId: 'line-1' }))
    expect(prismaMock.inventoryPosting.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'APPLIED' }) }),
    )
    expect(result?.issues).toEqual([])
  })

  it('una línea fallida deja PARTIAL_FAILED y el reintento NO re-deduce la aplicada', async () => {
    const lines = [line(), line({ id: 'line-2', effectKey: 'oi-2', orderItemId: 'oi-2', productId: 'p2', expectedQuantityBase: new Prisma.Decimal(1) })]
    prismaMock.inventoryPosting.findUnique.mockResolvedValue(posting(lines) as any)
    wireOrderItems([
      { id: 'oi-1', productId: 'p1', quantity: 2, weightQuantity: null, modifiers: [] },
      { id: 'oi-2', productId: 'p2', quantity: 1, weightQuantity: null, modifiers: [] },
    ])
    deductInventoryMock
      .mockResolvedValueOnce({ inventoryMethod: 'QUANTITY', remainingStock: 3, productName: 'Coca' })
      .mockRejectedValueOnce(new Error('deadlock'))

    const first = await applySalePosting('post-1', 'staff-1')
    expect(first?.issues).toHaveLength(1)
    expect(prismaMock.inventoryPosting.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PARTIAL_FAILED' }) }),
    )

    // Reintento: la línea 1 ya está APPLIED; solo la 2 se re-aplica.
    jest.clearAllMocks()
    getInventoryMethodMock.mockResolvedValue('QUANTITY')
    prismaMock.inventoryPosting.updateMany.mockResolvedValue({ count: 1 } as any)
    prismaMock.inventoryPostingLine.update.mockResolvedValue({} as any)
    prismaMock.inventoryPosting.update.mockResolvedValue({} as any)
    prismaMock.inventoryPosting.findUnique.mockResolvedValue(
      posting([line({ status: 'APPLIED' }), line({ id: 'line-2', effectKey: 'oi-2', orderItemId: 'oi-2', productId: 'p2', status: 'FAILED', expectedQuantityBase: new Prisma.Decimal(1) })]) as any,
    )
    wireOrderItems([
      { id: 'oi-1', productId: 'p1', quantity: 2, weightQuantity: null, modifiers: [] },
      { id: 'oi-2', productId: 'p2', quantity: 1, weightQuantity: null, modifiers: [] },
    ])
    deductInventoryMock.mockResolvedValue({ inventoryMethod: 'QUANTITY', remainingStock: 7, productName: 'Sprite' })

    await applySalePosting('post-1', 'staff-1')

    expect(deductInventoryMock).toHaveBeenCalledTimes(1)
    expect(deductInventoryMock).toHaveBeenCalledWith(VENUE, 'p2', 1, ORDER, 'staff-1', [], expect.anything())
  })

  it('stock en negativo es APPLIED (Square-parity) y viaja como issue para el toast', async () => {
    prismaMock.inventoryPosting.findUnique.mockResolvedValue(posting([line()]) as any)
    wireOrderItems([{ id: 'oi-1', productId: 'p1', quantity: 2, weightQuantity: null, modifiers: [] }])
    deductInventoryMock.mockResolvedValue({ inventoryMethod: 'QUANTITY', remainingStock: -1, productName: 'Cerveza Corona' })

    const result = await applySalePosting('post-1', 'staff-1')

    expect(prismaMock.inventoryPosting.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'APPLIED' }) }),
    )
    expect(result?.issues).toHaveLength(1)
    expect(result?.issues[0]).toMatchObject({ productId: 'p1', available: -1 })
  })

  it('quien pierde el claim CAS no aplica nada (otro worker lo tiene)', async () => {
    prismaMock.inventoryPosting.updateMany.mockResolvedValue({ count: 0 } as any)

    const result = await applySalePosting('post-1', 'staff-1')

    expect(result).toBeNull()
    expect(deductInventoryMock).not.toHaveBeenCalled()
  })
})
