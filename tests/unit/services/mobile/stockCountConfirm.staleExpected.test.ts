import { prismaMock } from '../../../__helpers__/setup'
import { confirmStockCount } from '@/services/mobile/inventory.mobile.service'

/**
 * Un conteo se crea con una FOTO de lo que el sistema cree que hay (`expected`).
 * El ajuste debe medirse contra el stock ACTUAL, no contra esa foto: entre que
 * el conteo se abre y se confirma hay ventas, compras y hasta otros conteos.
 *
 * Caso REAL medido en la DB local el 2026-08-12: el conteo
 * `cmsqdfi13006oc9uky3iycuuy` quedó abierto con `expected = 89` de Cerveza
 * Corona; para cuando alguien lo retomaría, el stock real era 32 (otro conteo lo
 * bajó a 10 y luego a 7, y entró una compra de +25). Contar 89 botellas físicas
 * daba `89 - 89 = 0` contra la foto → el server hacía `continue` y NO ajustaba
 * nada, dejando el inventario en 32 y marcando el conteo como COMPLETADO.
 * Un conteo que canta éxito sin corregir es peor que no contar.
 *
 * El mismo servicio YA lo hace bien con los insumos (delta contra
 * `currentStock`); a los productos les faltaba.
 */
describe('confirmStockCount — el ajuste se mide contra el stock ACTUAL, no contra la foto', () => {
  const countId = 'count-1'
  const venueId = 'venue-1'
  const userId = 'staff-1'

  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.stockCount.update.mockResolvedValue({ id: countId } as any)
    prismaMock.$transaction.mockImplementation(async (ops: any) => (Array.isArray(ops) ? ops : ops(prismaMock)))
  })

  /** Arma un conteo de UN producto ya contado. */
  const armarConteo = (opciones: { expected: number; counted: number; currentStock: number }) => {
    prismaMock.stockCount.findFirst.mockResolvedValue({
      id: countId,
      venueId,
      status: 'IN_PROGRESS',
      items: [
        {
          id: 'item-1',
          productId: 'prod-corona',
          rawMaterialId: null,
          rawMaterial: null,
          expected: opciones.expected,
          counted: opciones.counted,
          countedAt: new Date(),
          product: {
            id: 'prod-corona',
            name: 'Cerveza Corona',
            inventory: { id: 'inv-1', currentStock: opciones.currentStock },
          },
        },
      ],
    } as any)
  }

  it('ajusta cuando lo contado coincide con la foto vieja pero NO con el stock de hoy', async () => {
    // La foto decía 89; hoy el sistema cree que hay 32; el cajero cuenta 89 reales.
    armarConteo({ expected: 89, counted: 89, currentStock: 32 })

    await confirmStockCount(countId, venueId, userId)

    expect(prismaMock.inventory.update).toHaveBeenCalledWith({
      where: { id: 'inv-1' },
      data: expect.objectContaining({ currentStock: 89 }),
    })
  })

  it('el movimiento registra la diferencia REAL (stock de hoy → contado)', async () => {
    armarConteo({ expected: 89, counted: 89, currentStock: 32 })

    await confirmStockCount(countId, venueId, userId)

    expect(prismaMock.inventoryMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'COUNT',
        quantity: 57, // 89 − 32, no 89 − 89
        previousStock: 32,
        newStock: 89,
      }),
    })
  })

  it('no toca nada cuando lo contado YA coincide con el stock de hoy', async () => {
    armarConteo({ expected: 89, counted: 32, currentStock: 32 })

    await confirmStockCount(countId, venueId, userId)

    expect(prismaMock.inventory.update).not.toHaveBeenCalled()
    expect(prismaMock.inventoryMovement.create).not.toHaveBeenCalled()
  })

  // ── Regresión: el caso normal (foto fresca) sigue funcionando igual ────────
  it('sigue ajustando el conteo normal, con la foto todavía al día', async () => {
    armarConteo({ expected: 89, counted: 10, currentStock: 89 })

    await confirmStockCount(countId, venueId, userId)

    expect(prismaMock.inventory.update).toHaveBeenCalledWith({
      where: { id: 'inv-1' },
      data: expect.objectContaining({ currentStock: 10 }),
    })
    expect(prismaMock.inventoryMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ quantity: -79, previousStock: 89, newStock: 10 }),
    })
  })

  it('marca el conteo como COMPLETED', async () => {
    armarConteo({ expected: 89, counted: 89, currentStock: 32 })

    await confirmStockCount(countId, venueId, userId)

    expect(prismaMock.stockCount.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED' }) }),
    )
  })
})
