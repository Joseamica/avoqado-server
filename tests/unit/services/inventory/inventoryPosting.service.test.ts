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
const getInventoryMethodsMock = jest.fn()
jest.mock('@/services/dashboard/productInventoryIntegration.service', () => ({
  deductInventoryForProduct: (...args: unknown[]) => deductInventoryMock(...args),
  getProductInventoryMethod: (...args: unknown[]) => getInventoryMethodMock(...args),
  getProductInventoryMethods: (...args: unknown[]) => getInventoryMethodsMock(...args),
}))

import { applySalePosting, createSalePostingInTx } from '@/services/inventory/inventoryPosting.service'

const VENUE = 'venue-1'
const ORDER = 'order-1'

describe('createSalePostingInTx', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Clasificación en batch (UNA consulta para todos los productos del ticket).
    getInventoryMethodsMock.mockImplementation(async (ids: string[]) => new Map(ids.map(id => [id, 'QUANTITY'])))
    // Pre-check de duplicado: por default no existe posting previo.
    prismaMock.inventoryPosting.findUnique.mockResolvedValue(null as any)
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
    getInventoryMethodsMock.mockResolvedValue(new Map())
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

  it('el duplicado se detecta con pre-check ANTES del create (nunca 25P02 en la tx del cobro)', async () => {
    // 🔴 Regresión real: el fallback viejo atrapaba P2002 y hacía findUnique en
    // la MISMA tx interactiva — pero Postgres ya la había abortado, así que el
    // "camino idempotente" moría con 25P02 y tiraba el cobro completo. El
    // pre-check corre antes de tocar el UNIQUE: cero abort, cero re-deducción.
    prismaMock.inventoryPosting.findUnique.mockResolvedValue({ id: 'post-existente', status: 'APPLIED' } as any)

    const posting = await createSalePostingInTx(prismaMock as any, {
      venueId: VENUE,
      orderId: ORDER,
      items: items as any,
      staffId: 'staff-1',
    })

    expect(posting).toMatchObject({ id: 'post-existente' })
    expect(prismaMock.inventoryPosting.create).not.toHaveBeenCalled()
  })

  it('clasifica los productos en UNA llamada batch (no N+1 dentro de la tx del cobro)', async () => {
    prismaMock.inventoryPosting.create.mockResolvedValue({ id: 'post-1', status: 'PENDING' } as any)

    await createSalePostingInTx(prismaMock as any, {
      venueId: VENUE,
      orderId: ORDER,
      items: items as any,
      staffId: 'staff-1',
    })

    expect(getInventoryMethodsMock).toHaveBeenCalledTimes(1)
    expect(getInventoryMethodsMock.mock.calls[0][0]).toEqual(['p1', 'p3'])
    expect(getInventoryMethodMock).not.toHaveBeenCalled()
  })
})

describe('applySalePosting', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    getInventoryMethodMock.mockResolvedValue('QUANTITY')
    prismaMock.inventoryPosting.updateMany.mockResolvedValue({ count: 1 } as any)
    prismaMock.inventoryPostingLine.update.mockResolvedValue({} as any)
    prismaMock.inventoryPosting.update.mockResolvedValue({} as any)
    // Guard anti doble-deducción: por default la línea NO tiene movimientos.
    prismaMock.inventoryMovement.count.mockResolvedValue(0 as any)
    prismaMock.rawMaterialMovement.count.mockResolvedValue(0 as any)
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

    expect(deductInventoryMock).toHaveBeenCalledWith(
      VENUE,
      'p1',
      2,
      ORDER,
      'staff-1',
      [],
      expect.objectContaining({ postingLineId: 'line-1' }),
    )
    expect(prismaMock.inventoryPosting.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'APPLIED' }) }),
    )
    expect(result?.issues).toEqual([])
  })

  it('una línea fallida deja PARTIAL_FAILED y el reintento NO re-deduce la aplicada', async () => {
    const lines = [
      line(),
      line({ id: 'line-2', effectKey: 'oi-2', orderItemId: 'oi-2', productId: 'p2', expectedQuantityBase: new Prisma.Decimal(1) }),
    ]
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
    prismaMock.inventoryMovement.count.mockResolvedValue(0 as any)
    prismaMock.rawMaterialMovement.count.mockResolvedValue(0 as any)
    prismaMock.inventoryPosting.findUnique.mockResolvedValue(
      posting([
        line({ status: 'APPLIED' }),
        line({
          id: 'line-2',
          effectKey: 'oi-2',
          orderItemId: 'oi-2',
          productId: 'p2',
          status: 'FAILED',
          expectedQuantityBase: new Prisma.Decimal(1),
        }),
      ]) as any,
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

  it('el claim CAS puede rescatar un APPLYING huérfano (lease vencido)', async () => {
    // Un crash entre el CAS y el update final dejaba el posting APPLYING para
    // siempre: ni este predicado ni el sweeper podían volver a tocarlo. El
    // claim ahora acepta APPLYING con updatedAt más viejo que el lease.
    prismaMock.inventoryPosting.findUnique.mockResolvedValue(posting([line()]) as any)
    wireOrderItems([{ id: 'oi-1', productId: 'p1', quantity: 2, weightQuantity: null, modifiers: [] }])
    deductInventoryMock.mockResolvedValue({ inventoryMethod: 'QUANTITY', remainingStock: 5, productName: 'Coca' })

    await applySalePosting('post-1', 'staff-1')

    const claimWhere = (prismaMock.inventoryPosting.updateMany.mock.calls[0][0] as any).where
    const staleClause = claimWhere.OR.find((c: any) => c.status === 'APPLYING')
    expect(staleClause).toBeDefined()
    expect(staleClause.updatedAt.lt).toBeInstanceOf(Date)
    // El lease es de 10 min: el corte tiene que estar en el pasado.
    expect(staleClause.updatedAt.lt.getTime()).toBeLessThan(Date.now())
  })

  it('línea con movimientos existentes se RECUPERA sin re-deducir (crash entre deducción y flip)', async () => {
    // 🔴 El P1 de la doble deducción: la deducción commitea en SU transacción y
    // el flip a APPLIED corre después. Si el proceso muere en esa ventana, la
    // línea queda PENDING con el stock ya descontado. El kardex (postingLineId
    // en los movimientos) prueba que ya ocurrió: se recupera el estado, no se
    // repite el efecto.
    prismaMock.inventoryPosting.findUnique.mockResolvedValue(posting([line()]) as any)
    wireOrderItems([{ id: 'oi-1', productId: 'p1', quantity: 2, weightQuantity: null, modifiers: [] }])
    prismaMock.rawMaterialMovement.count.mockResolvedValue(3 as any) // receta ya deducida

    const result = await applySalePosting('post-1', 'staff-1')

    expect(deductInventoryMock).not.toHaveBeenCalled()
    expect(prismaMock.inventoryPostingLine.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'line-1' },
        data: expect.objectContaining({ status: 'APPLIED', reason: 'RECOVERED_FROM_MOVEMENTS' }),
      }),
    )
    expect(prismaMock.inventoryPosting.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'APPLIED' }) }),
    )
    expect(result?.issues).toEqual([])
  })
})
