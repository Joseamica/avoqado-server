/**
 * Tests: TODO escritor de saldo inicial deja rastro en el kardex.
 *
 * Contexto (audit Codex xhigh 2026-08-14 + medición en av-db-25): el descuadre
 * real medido NO venía de las ventas, venía del ARRANQUE — el asistente de
 * producto y el import de menú escribían `Inventory.currentStock` sin crear el
 * `InventoryMovement` correspondiente. Resultado: la reconciliación
 * `currentStock == primerMovimiento.previousStock + Σ(deltas)` es imposible de
 * cumplir, y la fase 4 (vigilante nocturno) reportaría ruido para siempre.
 *
 * Regla que fijan estos tests: **si una escritura cambia el saldo, deja
 * movimiento.** Sin excepción, incluido el saldo de apertura (previousStock 0).
 * Y el asistente NO puede pisar en silencio un inventario que ya tiene saldo:
 * la diferencia se registra como ajuste, con su rastro.
 */

import { prismaMock } from '../../../__helpers__/setup'

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import { setupSimpleStockStep3 } from '@/services/dashboard/productWizard.service'

const VENUE = 'venue-1'
const PRODUCT = 'prod-1'

describe('productWizard — el saldo inicial deja movimiento', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
    prismaMock.product.findUnique.mockResolvedValue({ id: PRODUCT, venueId: VENUE, recipe: null } as any)
    prismaMock.product.update.mockResolvedValue({ id: PRODUCT } as any)
    prismaMock.inventory.create.mockResolvedValue({ id: 'inv-1', currentStock: 25 } as any)
    prismaMock.inventory.update.mockResolvedValue({ id: 'inv-1', currentStock: 25 } as any)
    prismaMock.inventoryMovement.create.mockResolvedValue({ id: 'mov-1' } as any)
    // El paso 3 asegura la fila y lee el saldo BAJO CANDADO (`SELECT … FOR UPDATE`) en la misma
    // transacción: la fila nace en 0 si no existía, y el saldo previo sale de esa lectura.
    prismaMock.inventory.createMany.mockResolvedValue({ count: 1 } as any)
    prismaMock.inventoryMovement.findFirst.mockResolvedValue(null as any)
  })
  const saldoBajoCandado = (currentStock: number) => prismaMock.$queryRaw.mockResolvedValue([{ id: 'inv-1', currentStock }] as any)

  const data = { initialStock: 25, reorderPoint: 5, costPerUnit: 10 } as any

  it('inventario NUEVO: crea el saldo Y su movimiento de apertura (0 → 25)', async () => {
    saldoBajoCandado(0) // la fila acaba de nacer en 0

    await setupSimpleStockStep3(VENUE, PRODUCT, data)

    expect(prismaMock.inventory.createMany).toHaveBeenCalled()
    expect(prismaMock.inventoryMovement.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'ADJUSTMENT',
          previousStock: expect.anything(),
          newStock: expect.anything(),
        }),
      }),
    )
    const mov = (prismaMock.inventoryMovement.create.mock.calls[0][0] as any).data
    expect(Number(mov.previousStock)).toBe(0)
    expect(Number(mov.newStock)).toBe(25)
    expect(Number(mov.quantity)).toBe(25)
  })

  it('inventario EXISTENTE con saldo: registra el AJUSTE con su delta real (8 → 25 = +17)', async () => {
    saldoBajoCandado(8)

    await setupSimpleStockStep3(VENUE, PRODUCT, data)

    const mov = (prismaMock.inventoryMovement.create.mock.calls[0][0] as any).data
    expect(Number(mov.previousStock)).toBe(8)
    expect(Number(mov.newStock)).toBe(25)
    expect(Number(mov.quantity)).toBe(17)
  })

  it('si el saldo NO cambia, no inventa un movimiento de cero', async () => {
    saldoBajoCandado(25)

    await setupSimpleStockStep3(VENUE, PRODUCT, data)

    expect(prismaMock.inventoryMovement.create).not.toHaveBeenCalled()
  })
})

// PR #273 del DASHBOARD: cambiar sólo mínimo o costo ya no obliga a mandar existencias (el panel releía el saldo y quedaban
// milisegundos para pisar una venta). Sin `initialStock` el saldo no se toca ni se anota movimiento.
describe('productWizard paso 3 — mínimo y costo sin existencias', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
    prismaMock.product.findUnique.mockResolvedValue({ id: PRODUCT, venueId: VENUE, recipe: null, updatedAt: new Date(version) } as any)
    prismaMock.product.update.mockResolvedValue({ id: PRODUCT } as any)
    prismaMock.inventory.createMany.mockResolvedValue({ count: 0 } as any)
    prismaMock.inventory.update.mockResolvedValue({ id: 'inv-1' } as any)
    prismaMock.inventoryMovement.findFirst.mockResolvedValue({ id: 'mov-0' } as any)
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'inv-1', currentStock: 5 }] as any)
  })
  const version = '2026-11-05T18:00:00.123Z'

  it('sin existencias: guarda mínimo y costo, no toca el saldo ni deja movimiento', async () => {
    const r = await setupSimpleStockStep3(VENUE, PRODUCT, { reorderPoint: 4, costPerUnit: 12 } as any)

    const inv = (prismaMock.inventory.update.mock.calls[0][0] as any).data
    expect(inv).not.toHaveProperty('currentStock')
    expect(Number(inv.minimumStock)).toBe(4)
    expect(Number((prismaMock.product.update.mock.calls[0][0] as any).data.cost)).toBe(12)
    expect(prismaMock.inventoryMovement.create).not.toHaveBeenCalled()
    expect(r.initialStock).toBe(5) // contesta el saldo real
  })

  it('con versión: la exige al escribir el producto', async () => {
    await setupSimpleStockStep3(VENUE, PRODUCT, { reorderPoint: 4, costPerUnit: 12, expectedUpdatedAt: version } as any)
    expect((prismaMock.product.update.mock.calls[0][0] as any).where).toEqual({ id: PRODUCT, updatedAt: new Date(version) })
  })

  it('con versión vieja al leer: 409 PRODUCT_CHANGED sin tocar el inventario', async () => {
    prismaMock.product.findUnique.mockResolvedValue({ id: PRODUCT, recipe: null, updatedAt: new Date('2026-11-05T18:00:01.000Z') } as any)
    await expect(
      setupSimpleStockStep3(VENUE, PRODUCT, { initialStock: 9, reorderPoint: 4, costPerUnit: 12, expectedUpdatedAt: version } as any),
    ).rejects.toMatchObject({ statusCode: 409, code: 'PRODUCT_CHANGED' })
    expect(prismaMock.inventory.update).not.toHaveBeenCalled()
  })

  it('con versión vieja al escribir (cambió en medio): 409 PRODUCT_CHANGED', async () => {
    prismaMock.product.update.mockRejectedValueOnce({ code: 'P2025' })
    await expect(
      setupSimpleStockStep3(VENUE, PRODUCT, { reorderPoint: 4, costPerUnit: 12, expectedUpdatedAt: version } as any),
    ).rejects.toMatchObject({ statusCode: 409, code: 'PRODUCT_CHANGED' })
  })

  it('con receta y versión vieja bajo el candado: 409 antes de cambiar el método', async () => {
    prismaMock.product.findUnique.mockResolvedValue({ id: PRODUCT, recipe: { id: 'r1' }, updatedAt: new Date(version) } as any)
    prismaMock.$queryRaw.mockResolvedValueOnce([{ updatedAt: new Date('2026-11-05T18:00:01.000Z') }] as any)
    await expect(
      setupSimpleStockStep3(VENUE, PRODUCT, { reorderPoint: 4, costPerUnit: 12, expectedUpdatedAt: version } as any),
    ).rejects.toMatchObject({ statusCode: 409, code: 'PRODUCT_CHANGED' })
    expect(prismaMock.product.update).not.toHaveBeenCalled()
  })
})

describe('ProductWizardStep3SimpleStockSchema — existencias opcionales y mensajes en español', () => {
  const { ProductWizardStep3SimpleStockSchema } = jest.requireActual('@/schemas/dashboard/inventory.schema')
  const params = { venueId: 'cjld2cjxh0000qzrmn831i7rn', productId: 'cjld2cyuq0000t3rmniod1foy' }

  it('acepta mínimo y costo sin existencias', () => {
    expect(ProductWizardStep3SimpleStockSchema.safeParse({ params, body: { reorderPoint: 3, costPerUnit: 5 } }).success).toBe(true)
  })

  it('existencias en blanco (null): dice en español qué falta', () => {
    const r = ProductWizardStep3SimpleStockSchema.safeParse({ params, body: { initialStock: null, reorderPoint: 3, costPerUnit: 5 } })
    expect(r.success).toBe(false)
    expect(r.error.issues[0].message).toMatch(/existencias/i)
    expect(r.error.issues[0].message).not.toMatch(/Expected/)
  })

  it('acepta la versión esperada en ISO', () => {
    const body = { reorderPoint: 3, costPerUnit: 5, expectedUpdatedAt: '2026-11-05T18:00:00.123Z' }
    expect(ProductWizardStep3SimpleStockSchema.safeParse({ params, body }).success).toBe(true)
  })
})
