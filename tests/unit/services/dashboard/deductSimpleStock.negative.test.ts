import { prismaMock } from '../../../__helpers__/setup'
import { deductInventoryForProduct } from '@/services/dashboard/productInventoryIntegration.service'
import { logAction } from '@/services/dashboard/activity-log.service'

/**
 * Una venta COBRADA nunca se bloquea por inventario: si el registro dice 2 y
 * el cliente pagó 3, el stock queda en −1 y ese negativo ES la señal de
 * descuadre (decisión founder+Claude 2026-08-12, espejo de Square: "you won't
 * be blocked from selling an out of stock item"; el aviso avisa, no bloquea).
 *
 * Antes: el decremento era condicional (`WHERE currentStock >= qty`) y con
 * stock insuficiente lanzaba "Insufficient stock" — lo que arriba revertía la
 * orden YA COBRADA a PENDING: cliente pagado y cuenta abierta.
 *
 * El mock de `$queryRaw` emula al Postgres real para un caso stock=2, venta=3:
 * la consulta CONDICIONAL (contiene `>=`) no afecta filas → `[]`; la
 * INCONDICIONAL sí decrementa → fila con el stock ya en negativo. Así este
 * test falla con el código viejo por la razón real, no por un mock a modo.
 */
describe('deductSimpleStock — la venta cobrada deja el stock en negativo, no truena', () => {
  const VENUE = 'venue-1'
  const PRODUCT = 'prod-corona'
  const ORDER = 'order-1'

  const producto = {
    id: PRODUCT,
    name: 'Cerveza Corona',
    trackInventory: true,
    inventoryMethod: 'QUANTITY',
    recipe: null,
    venue: { features: [] },
  }

  /** Emula la respuesta del Postgres para stock=2, venta=3. */
  const emularDb = (stockActual: number, cantidad: number) => {
    prismaMock.$queryRaw.mockImplementation((strings: TemplateStringsArray) => {
      const sql = Array.isArray(strings) ? strings.join('$') : String(strings)
      if (sql.includes('>=')) {
        // Decremento condicional: sin stock suficiente no afecta filas.
        return Promise.resolve(
          stockActual >= cantidad ? [{ id: 'inv-1', currentStock: stockActual - cantidad, previousStock: stockActual }] : [],
        )
      }
      // Decremento incondicional: siempre afecta la fila (puede quedar negativa).
      return Promise.resolve([{ id: 'inv-1', currentStock: stockActual - cantidad, previousStock: stockActual }])
    })
  }

  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.product.findUnique.mockResolvedValue(producto as any)
    prismaMock.inventory.findUnique.mockResolvedValue({ id: 'inv-1', currentStock: 2 } as any)
    prismaMock.inventoryMovement.create.mockResolvedValue({} as any)
  })

  it('con stock 2 y venta de 3, deduce a −1 en vez de lanzar', async () => {
    emularDb(2, 3)

    const result: any = await deductInventoryForProduct(VENUE, PRODUCT, 3, ORDER, 'staff-1')

    expect(result.remainingStock).toBe(-1)
  })

  it('el movimiento registra la venta completa con el antes/después reales', async () => {
    emularDb(2, 3)

    await deductInventoryForProduct(VENUE, PRODUCT, 3, ORDER, 'staff-1')

    expect(prismaMock.inventoryMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'SALE',
        reference: ORDER,
      }),
    })
    const data = prismaMock.inventoryMovement.create.mock.calls[0][0].data
    expect(Number(data.quantity)).toBe(-3)
    expect(Number(data.previousStock)).toBe(2)
    expect(Number(data.newStock)).toBe(-1)
  })

  it('cruzar a negativo se audita en ActivityLog (es la señal de descuadre)', async () => {
    emularDb(2, 3)

    await deductInventoryForProduct(VENUE, PRODUCT, 3, ORDER, 'staff-1')

    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'STOCK_WENT_NEGATIVE', venueId: VENUE, entityId: PRODUCT }))
  })

  // ── Regresión: lo que ya funcionaba sigue igual ──────────────────────────
  it('una venta normal con stock de sobra no audita nada raro', async () => {
    emularDb(100, 3)

    const result: any = await deductInventoryForProduct(VENUE, PRODUCT, 3, ORDER, 'staff-1')

    expect(result.remainingStock).toBe(97)
    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'STOCK_WENT_NEGATIVE' }))
  })

  it('un producto sin fila de Inventory sigue siendo error de configuración (404)', async () => {
    prismaMock.$queryRaw.mockResolvedValue([])
    prismaMock.inventory.findUnique.mockResolvedValue(null)

    await expect(deductInventoryForProduct(VENUE, PRODUCT, 3, ORDER, 'staff-1')).rejects.toThrow(/No inventory record/)
  })
})
