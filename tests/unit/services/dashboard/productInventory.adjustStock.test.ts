/**
 * adjustInventoryStock (productos QUANTITY) — fase 3 del plan de inventario.
 *
 * Dos defectos corregidos aquí:
 *
 * 1. LOST UPDATE: leía `currentStock` fuera de la transacción y escribía
 *    `previousStock + qty` como VALOR ABSOLUTO — un ajuste concurrente con una
 *    venta (o con otro ajuste) se pisaba en silencio. Fix: `{ increment }` y el
 *    movimiento deriva previousStock/newStock del RESULTADO atómico.
 *
 * 2. NEGATIVOS INCORREGIBLES: prohibía cualquier resultado < 0, pero la VENTA
 *    sí deja stock negativo a propósito (Square-parity, 2026-08-12). Un
 *    producto en −3 no se podía ajustar (ni −1 ni +2 llegaban a ≥ 0). Fix: el
 *    ajuste manual se permite cuando el stock YA estaba en negativo; lo único
 *    que sigue prohibido es llevar un stock ≥ 0 a negativo por ajuste manual
 *    (guardia anti-typo — el camino legítimo hacia negativo es la venta).
 */

import { Decimal } from '@prisma/client/runtime/library'
import { prismaMock } from '../../../__helpers__/setup'
import { adjustInventoryStock } from '../../../../src/services/dashboard/productInventory.service'

const VENUE_ID = 'venue-1'
const PRODUCT_ID = 'product-1'

const mockProduct = (stock: number) => ({
  id: PRODUCT_ID,
  venueId: VENUE_ID,
  name: 'Cerveza Corona',
  trackInventory: true,
  inventoryMethod: 'QUANTITY',
  inventory: {
    id: 'inv-1',
    productId: PRODUCT_ID,
    currentStock: new Decimal(stock),
    minimumStock: new Decimal(2),
    reservedStock: new Decimal(0),
    lastCountedAt: null,
  },
})

const mockUpdatedInventory = (stock: number) => ({
  id: 'inv-1',
  currentStock: new Decimal(stock),
  minimumStock: new Decimal(2),
  reservedStock: new Decimal(0),
})

describe('adjustInventoryStock — incremento atómico y corrección de negativos', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (arg: any) => (typeof arg === 'function' ? arg(prismaMock) : Promise.all(arg)))
  })

  it('escribe currentStock con { increment }, nunca un valor absoluto', async () => {
    prismaMock.product.findFirst.mockResolvedValue(mockProduct(10))
    prismaMock.inventory.update.mockResolvedValue(mockUpdatedInventory(15))
    prismaMock.inventoryMovement.create.mockResolvedValue({})

    await adjustInventoryStock(VENUE_ID, PRODUCT_ID, { type: 'ADJUSTMENT', quantity: 5 } as any, 'staff-1')

    // D2: la cantidad viaja como decimal exacto a 3 decimales (Codex r2 #2); sigue siendo un `increment`, nunca un absoluto.
    const { currentStock } = prismaMock.inventory.update.mock.calls[0][0].data
    expect(Object.keys(currentStock)).toEqual(['increment'])
    expect(Number(currentStock.increment)).toBe(5)
  })

  it('el movimiento deriva previousStock/newStock del resultado atómico (no de la lectura vieja)', async () => {
    // Lectura fuera de tx: 10. Una venta concurrente bajó 3 → la base resuelve
    // 10 − 3 + 5 = 12.
    prismaMock.product.findFirst.mockResolvedValue(mockProduct(10))
    prismaMock.inventory.update.mockResolvedValue(mockUpdatedInventory(12))
    prismaMock.inventoryMovement.create.mockResolvedValue({})

    const result = await adjustInventoryStock(VENUE_ID, PRODUCT_ID, { type: 'ADJUSTMENT', quantity: 5 } as any, 'staff-1')

    const movement = prismaMock.inventoryMovement.create.mock.calls[0][0]
    expect(Number(movement.data.previousStock)).toBe(7)
    expect(Number(movement.data.newStock)).toBe(12)
    expect(result.currentStock).toBe(12)
  })

  it('permite ajustar a la baja un producto YA en negativo (−3 → −4)', async () => {
    prismaMock.product.findFirst.mockResolvedValue(mockProduct(-3))
    prismaMock.inventory.update.mockResolvedValue(mockUpdatedInventory(-4))
    prismaMock.inventoryMovement.create.mockResolvedValue({})

    const result = await adjustInventoryStock(VENUE_ID, PRODUCT_ID, { type: 'ADJUSTMENT', quantity: -1 } as any, 'staff-1')

    expect(result.currentStock).toBe(-4)
    const movement = prismaMock.inventoryMovement.create.mock.calls[0][0]
    expect(Number(movement.data.previousStock)).toBe(-3)
    expect(Number(movement.data.newStock)).toBe(-4)
  })

  it('permite abonar a un producto en negativo aunque no alcance el cero (−3 → −1)', async () => {
    prismaMock.product.findFirst.mockResolvedValue(mockProduct(-3))
    prismaMock.inventory.update.mockResolvedValue(mockUpdatedInventory(-1))
    prismaMock.inventoryMovement.create.mockResolvedValue({})

    const result = await adjustInventoryStock(VENUE_ID, PRODUCT_ID, { type: 'ADJUSTMENT', quantity: 2 } as any, 'staff-1')

    expect(result.currentStock).toBe(-1)
  })

  it('sigue rechazando llevar un stock ≥ 0 a negativo por ajuste manual (guardia anti-typo)', async () => {
    prismaMock.product.findFirst.mockResolvedValue(mockProduct(5))
    prismaMock.inventory.update.mockResolvedValue(mockUpdatedInventory(-3))
    prismaMock.inventoryMovement.create.mockResolvedValue({})

    await expect(adjustInventoryStock(VENUE_ID, PRODUCT_ID, { type: 'ADJUSTMENT', quantity: -8 } as any, 'staff-1')).rejects.toMatchObject({
      statusCode: 400,
    })

    // El throw ocurre DENTRO de la transacción → el update se revierte junto
    // con todo; el movimiento nunca se registra.
    expect(prismaMock.inventoryMovement.create).not.toHaveBeenCalled()
  })

  // ── Regresión: lo que ya funcionaba sigue igual ──────────────────────────
  it('PURCHASE con unitCost actualiza Product.cost dentro de la misma transacción', async () => {
    prismaMock.product.findFirst.mockResolvedValue(mockProduct(10))
    prismaMock.inventory.update.mockResolvedValue(mockUpdatedInventory(20))
    prismaMock.inventoryMovement.create.mockResolvedValue({})
    prismaMock.product.update.mockResolvedValue({})

    await adjustInventoryStock(VENUE_ID, PRODUCT_ID, { type: 'PURCHASE', quantity: 10, unitCost: 12.5 } as any, 'staff-1')

    expect(prismaMock.product.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PRODUCT_ID },
        data: expect.objectContaining({ cost: expect.anything() }),
      }),
    )
  })

  it('rechaza productos sin tracking QUANTITY (regresión)', async () => {
    prismaMock.product.findFirst.mockResolvedValue({ ...mockProduct(10), trackInventory: false, inventoryMethod: null })

    await expect(adjustInventoryStock(VENUE_ID, PRODUCT_ID, { type: 'ADJUSTMENT', quantity: 5 } as any, 'staff-1')).rejects.toMatchObject({
      statusCode: 400,
    })
  })

  // D2 (Codex r1 #5, r2 #1 y #5): dentro de la transacción se escribe la existencia y DESPUÉS se relee el producto (sin candado, para no
  // cruzarse con el asistente). Si ya no cuenta piezas o lo archivaron, todo se revierte.
  it.each([
    ['apagó el control', { trackInventory: false, inventoryMethod: 'QUANTITY', deletedAt: null }],
    ['lo pasó a receta', { trackInventory: true, inventoryMethod: 'RECIPE', deletedAt: null }],
    ['lo archivó', { trackInventory: true, inventoryMethod: 'QUANTITY', deletedAt: new Date() }],
    ['lo borró o es de otro negocio', null],
  ])('si entre la primera lectura y la escritura otra persona %s → 400 y la transacción se revierte', async (_caso, vigente) => {
    prismaMock.product.findFirst.mockResolvedValueOnce(mockProduct(10)).mockResolvedValueOnce(vigente)
    prismaMock.inventory.update.mockResolvedValue(mockUpdatedInventory(15))
    prismaMock.inventoryMovement.create.mockResolvedValue({})

    await expect(adjustInventoryStock(VENUE_ID, PRODUCT_ID, { type: 'ADJUSTMENT', quantity: 5 } as any, 'staff-1')).rejects.toMatchObject({
      statusCode: 400,
    })
  })

  it('la relectura va DESPUÉS de tomar la fila de existencias, acotada al negocio y sin candado del producto (Codex r2 #1)', async () => {
    prismaMock.product.findFirst.mockResolvedValue(mockProduct(10))
    prismaMock.inventory.update.mockResolvedValue(mockUpdatedInventory(15))
    prismaMock.inventoryMovement.create.mockResolvedValue({})

    await adjustInventoryStock(VENUE_ID, PRODUCT_ID, { type: 'ADJUSTMENT', quantity: 5 } as any, 'staff-1')

    expect(prismaMock.product.findFirst).toHaveBeenCalledTimes(2)
    expect(prismaMock.product.findFirst.mock.calls[1][0]).toMatchObject({ where: { id: PRODUCT_ID, venueId: VENUE_ID } })
    expect(prismaMock.inventory.update.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.product.findFirst.mock.invocationCallOrder[1])
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
  })

  it('un ajuste que no es conteo no vuelve a escribir la fecha del último conteo (Codex r2 #6)', async () => {
    prismaMock.product.findFirst.mockResolvedValue(mockProduct(10))
    prismaMock.inventory.update.mockResolvedValue(mockUpdatedInventory(15))
    prismaMock.inventoryMovement.create.mockResolvedValue({})

    await adjustInventoryStock(VENUE_ID, PRODUCT_ID, { type: 'ADJUSTMENT', quantity: 5 } as any, 'staff-1')

    expect(prismaMock.inventory.update.mock.calls[0][0].data).not.toHaveProperty('lastCountedAt')
  })

  it('la cantidad se redondea a 3 decimales antes de sumar: una resta de 0 − 0.0004 no se cuela como «ya era negativo» (Codex r2 #2)', async () => {
    prismaMock.product.findFirst.mockResolvedValue(mockProduct(0))
    // Postgres redondea el saldo a 3 decimales: con −0.0006 guarda −0.001.
    prismaMock.inventory.update.mockResolvedValue(mockUpdatedInventory(-0.001))
    prismaMock.inventoryMovement.create.mockResolvedValue({})

    await expect(
      adjustInventoryStock(VENUE_ID, PRODUCT_ID, { type: 'ADJUSTMENT', quantity: -0.0006 } as any, 'staff-1'),
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(Number(prismaMock.inventory.update.mock.calls[0][0].data.currentStock.increment)).toBe(-0.001)
    expect(prismaMock.inventoryMovement.create).not.toHaveBeenCalled()
  })

  it('si el asistente BORRÓ la fila (pasó el producto a receta) a la mitad: 400 «ya no cuenta piezas», no un 500 en duda (Codex r3 #6)', async () => {
    prismaMock.product.findFirst.mockResolvedValue(mockProduct(10))
    prismaMock.inventory.update.mockRejectedValue(Object.assign(new Error('Record to update not found.'), { code: 'P2025' }))

    await expect(adjustInventoryStock(VENUE_ID, PRODUCT_ID, { type: 'ADJUSTMENT', quantity: 5 } as any, 'staff-1')).rejects.toMatchObject({
      statusCode: 400,
    })
    expect(prismaMock.inventoryMovement.create).not.toHaveBeenCalled()
  })
})
