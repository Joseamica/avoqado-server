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
  })

  const data = { initialStock: 25, reorderPoint: 5, costPerUnit: 10 } as any

  it('inventario NUEVO: crea el saldo Y su movimiento de apertura (0 → 25)', async () => {
    prismaMock.inventory.findUnique.mockResolvedValue(null as any)

    await setupSimpleStockStep3(VENUE, PRODUCT, data)

    expect(prismaMock.inventory.create).toHaveBeenCalled()
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
    prismaMock.inventory.findUnique.mockResolvedValue({ id: 'inv-1', currentStock: 8 } as any)

    await setupSimpleStockStep3(VENUE, PRODUCT, data)

    const mov = (prismaMock.inventoryMovement.create.mock.calls[0][0] as any).data
    expect(Number(mov.previousStock)).toBe(8)
    expect(Number(mov.newStock)).toBe(25)
    expect(Number(mov.quantity)).toBe(17)
  })

  it('si el saldo NO cambia, no inventa un movimiento de cero', async () => {
    prismaMock.inventory.findUnique.mockResolvedValue({ id: 'inv-1', currentStock: 25 } as any)

    await setupSimpleStockStep3(VENUE, PRODUCT, data)

    expect(prismaMock.inventoryMovement.create).not.toHaveBeenCalled()
  })
})
