import { Decimal } from '@prisma/client/runtime/library'

import { prismaMock } from '../../../__helpers__/setup'
import { deductStockForRecipe } from '../../../../src/services/dashboard/rawMaterial.service'

/**
 * Receta TODO-O-NADA (fase 3 del plan de remediación de inventario).
 *
 * Antes, deductStockForRecipe recorría los insumos llamando a deductStockFIFO
 * uno por uno, y CADA llamada abría (y commiteaba) su propia transacción. Si la
 * receta tenía 5 insumos y el 5º fallaba (sin lotes, sin stock), los 4
 * anteriores YA estaban deducidos y commiteados: la venta no se registraba pero
 * el inventario sí bajaba, en silencio.
 *
 * Ahora la receta completa corre dentro de UNA transacción Serializable: o se
 * deducen todos los insumos, o ninguno.
 */

const venueId = 'venue-1'
const productId = 'product-1'
const orderId = 'order-1'

const gram = (n: number) => new Decimal(n)

const makeRawMaterial = (id: string, name: string, stock: number) => ({
  id,
  venueId,
  name,
  unit: 'GRAM',
  currentStock: gram(stock),
  reorderPoint: gram(0),
})

const makeBatch = (id: string, remaining: number) => ({
  id,
  batchNumber: `BATCH-${id}`,
  remainingQuantity: gram(remaining),
  costPerUnit: new Decimal(1),
  receivedDate: new Date('2026-01-01'),
  unit: 'GRAM',
})

const makeRecipeLine = (rawMaterialId: string, name: string, qty: number, overrides: Record<string, any> = {}) => ({
  id: `line-${rawMaterialId}`,
  rawMaterialId,
  quantity: gram(qty),
  unit: 'GRAM',
  isOptional: false,
  isVariable: false,
  linkedModifierGroupId: null,
  linkedModifierGroup: null,
  rawMaterial: makeRawMaterial(rawMaterialId, name, 100),
  ...overrides,
})

describe('deductStockForRecipe — receta todo-o-nada (una sola transacción)', () => {
  // Mocks COMPARTIDOS entre invocaciones de $transaction: así el test observa el
  // mismo flujo de datos sin importar cuántas transacciones abra la implementación.
  let rawMaterialFindFirst: jest.Mock
  let rawMaterialFindUniqueOrThrow: jest.Mock
  let rawMaterialUpdate: jest.Mock
  let lockQuery: jest.Mock
  let stockBatchUpdate: jest.Mock
  let movementCreate: jest.Mock
  let committedTransactions: number

  const buildTx = () => ({
    rawMaterial: {
      findFirst: rawMaterialFindFirst,
      findUniqueOrThrow: rawMaterialFindUniqueOrThrow,
      update: rawMaterialUpdate,
    },
    stockBatch: { update: stockBatchUpdate },
    rawMaterialMovement: { create: movementCreate },
    $queryRaw: lockQuery,
  })

  beforeEach(() => {
    jest.clearAllMocks()
    committedTransactions = 0
    rawMaterialFindFirst = jest.fn()
    rawMaterialFindUniqueOrThrow = jest.fn()
    rawMaterialUpdate = jest.fn().mockResolvedValue({})
    lockQuery = jest.fn()
    stockBatchUpdate = jest.fn().mockResolvedValue({})
    movementCreate = jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ ...data, batch: { batchNumber: 'B' } }))

    prismaMock.$transaction.mockImplementation(async (arg: any) => {
      if (typeof arg !== 'function') return Promise.all(arg)
      const result = await arg(buildTx())
      committedTransactions += 1
      return result
    })

    // Alertas de stock bajo (post-commit): sin alerta activa, sin creación.
    prismaMock.rawMaterial.findUnique.mockResolvedValue(makeRawMaterial('rm-any', 'Cualquiera', 100))
    prismaMock.lowStockAlert.findFirst.mockResolvedValue(null)
  })

  const armarReceta = (lines: any[]) => {
    prismaMock.recipe.findUnique.mockResolvedValue({
      id: 'recipe-1',
      productId,
      portionYield: 1,
      product: { id: productId, name: 'Hamburguesa' },
      lines,
    } as any)
  }

  it('si el 2º insumo truena, NINGUNA deducción queda commiteada', async () => {
    armarReceta([makeRecipeLine('rm-1', 'Harina', 10), makeRecipeLine('rm-2', 'Queso', 5)])

    // rm-1 sano; rm-2 sin lotes activos → AppError 400
    rawMaterialFindFirst
      .mockResolvedValueOnce(makeRawMaterial('rm-1', 'Harina', 100))
      .mockResolvedValueOnce(makeRawMaterial('rm-2', 'Queso', 100))
    lockQuery.mockResolvedValueOnce([makeBatch('b-1', 50)]).mockResolvedValueOnce([])

    await expect(deductStockForRecipe(venueId, productId, 1, orderId)).rejects.toThrow(/No active batches/)

    // El corazón del fix: la deducción de rm-1 NO debe quedar commiteada.
    expect(committedTransactions).toBe(0)
  })

  it('la receta completa corre en UNA sola transacción', async () => {
    armarReceta([makeRecipeLine('rm-1', 'Harina', 10), makeRecipeLine('rm-2', 'Queso', 5)])

    rawMaterialFindFirst
      .mockResolvedValueOnce(makeRawMaterial('rm-1', 'Harina', 100))
      .mockResolvedValueOnce(makeRawMaterial('rm-2', 'Queso', 100))
    lockQuery.mockResolvedValueOnce([makeBatch('b-1', 50)]).mockResolvedValueOnce([makeBatch('b-2', 50)])

    await deductStockForRecipe(venueId, productId, 1, orderId)

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(committedTransactions).toBe(1)
    // Ambos insumos se dedujeron (un movimiento por asignación de lote).
    const movedMaterials = movementCreate.mock.calls.map(([{ data }]: any) => data.rawMaterialId)
    expect(movedMaterials).toEqual(expect.arrayContaining(['rm-1', 'rm-2']))
  })

  it('un conflicto transitorio (P2034) reintenta la receta COMPLETA y termina bien', async () => {
    armarReceta([makeRecipeLine('rm-1', 'Harina', 10)])

    rawMaterialFindFirst.mockResolvedValue(makeRawMaterial('rm-1', 'Harina', 100))
    lockQuery.mockResolvedValue([makeBatch('b-1', 50)])

    const conflicto: any = new Error('write conflict')
    conflicto.code = 'P2034'
    prismaMock.$transaction.mockRejectedValueOnce(conflicto).mockImplementation(async (arg: any) => {
      if (typeof arg !== 'function') return Promise.all(arg)
      const result = await arg(buildTx())
      committedTransactions += 1
      return result
    })

    await deductStockForRecipe(venueId, productId, 1, orderId)

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
    expect(committedTransactions).toBe(1)
  })

  it('la sustitución (SUBSTITUTION) se deduce dentro de la MISMA transacción', async () => {
    armarReceta([makeRecipeLine('rm-leche', 'Leche entera', 100, { isVariable: true, linkedModifierGroupId: 'grupo-leches' })])

    const orderModifiers = [
      {
        quantity: 1,
        modifier: {
          id: 'mod-almendra',
          name: 'Leche de almendra',
          groupId: 'grupo-leches',
          rawMaterialId: 'rm-almendra',
          quantityPerUnit: gram(100),
          unit: 'GRAM' as any,
          inventoryMode: 'SUBSTITUTION' as any,
        },
      },
    ]

    rawMaterialFindUniqueOrThrow.mockResolvedValue(makeRawMaterial('rm-almendra', 'Leche de almendra', 500))
    rawMaterialFindFirst.mockResolvedValue(makeRawMaterial('rm-almendra', 'Leche de almendra', 500))
    lockQuery.mockResolvedValue([makeBatch('b-alm', 500)])

    await deductStockForRecipe(venueId, productId, 1, orderId, 'staff-1', orderModifiers as any)

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    // Se dedujo el insumo del modificador, no el de la receta.
    const movedMaterials = movementCreate.mock.calls.map(([{ data }]: any) => data.rawMaterialId)
    expect(movedMaterials).toEqual(['rm-almendra'])
    // La búsqueda del insumo sustituto corrió sobre el cliente de la transacción.
    expect(rawMaterialFindUniqueOrThrow).toHaveBeenCalled()
  })

  it('sin receta no abre transacción alguna (regresión)', async () => {
    prismaMock.recipe.findUnique.mockResolvedValue(null)

    await deductStockForRecipe(venueId, productId, 1, orderId)

    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })
})
