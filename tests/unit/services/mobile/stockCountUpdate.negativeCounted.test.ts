import { prismaMock } from '../../../__helpers__/setup'
import { updateStockCount } from '@/services/mobile/inventory.mobile.service'

/**
 * Un conteo físico no puede ser negativo: nadie cuenta "menos siete cervezas"
 * en el anaquel. OJO con la distinción: el DELTA del ajuste sí puede ser
 * negativo (contaste menos de lo que el sistema creía) — lo CONTADO, no.
 *
 * Sin esta validación, un negativo capturado (báscula con tara mal puesta, un
 * signo colado en el campo) se aplicaba tal cual al confirmar y dejaba el
 * inventario en un valor físicamente imposible SIN pasar por una venta — que
 * es el único camino donde el negativo es señal legítima de descuadre.
 */
describe('updateStockCount — lo contado nunca es negativo', () => {
  const COUNT = 'count-1'
  const VENUE = 'venue-1'

  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.stockCount.findFirst.mockResolvedValue({ id: COUNT, venueId: VENUE, status: 'IN_PROGRESS' } as any)
    prismaMock.stockCountItem.update.mockResolvedValue({} as any)
    prismaMock.stockCount.update.mockResolvedValue({} as any)
  })

  it('rechaza un counted negativo con mensaje en español', async () => {
    await expect(updateStockCount(COUNT, VENUE, [{ id: 'item-1', counted: -5 }])).rejects.toThrow(/no puede ser negativa/)
  })

  it('el rechazo es TODO-o-nada: no guarda ni las líneas válidas del mismo lote', async () => {
    await expect(
      updateStockCount(COUNT, VENUE, [
        { id: 'item-1', counted: 10 },
        { id: 'item-2', counted: -1 },
      ]),
    ).rejects.toThrow(/no puede ser negativa/)

    expect(prismaMock.stockCountItem.update).not.toHaveBeenCalled()
  })

  // ── Regresión ────────────────────────────────────────────────────────────
  it('contar CERO sigue siendo válido: es un dato, no un error', async () => {
    await expect(updateStockCount(COUNT, VENUE, [{ id: 'item-1', counted: 0 }])).resolves.toEqual({ success: true })
    expect(prismaMock.stockCountItem.update).toHaveBeenCalledTimes(1)
  })

  it('un conteo normal sigue guardando todas sus líneas', async () => {
    await expect(
      updateStockCount(COUNT, VENUE, [
        { id: 'item-1', counted: 12 },
        { id: 'item-2', counted: 0.75 },
      ]),
    ).resolves.toEqual({ success: true })
    expect(prismaMock.stockCountItem.update).toHaveBeenCalledTimes(2)
  })
})
