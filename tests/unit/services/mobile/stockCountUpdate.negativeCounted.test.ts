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
    // Las líneas que SÍ pertenecen al conteo (para el guard de tenant).
    prismaMock.stockCountItem.findMany.mockResolvedValue([{ id: 'item-1' }, { id: 'item-2' }] as any)
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

  // ── Tenant isolation (audit Codex 2026-08-12, P1) ────────────────────────
  // El servicio validaba que el CONTEO fuera del venue, pero actualizaba las
  // líneas por `id` pelón: un usuario del venue A podía mutar líneas de un
  // conteo del venue B mandando sus ids en el body.
  it('rechaza TODO el lote si una línea no pertenece a este conteo', async () => {
    // El conteo sólo tiene item-1 e item-2; item-ajeno es de otro conteo/venue.
    prismaMock.stockCountItem.findMany.mockResolvedValue([{ id: 'item-1' }, { id: 'item-2' }] as any)

    await expect(
      updateStockCount(COUNT, VENUE, [
        { id: 'item-1', counted: 5 },
        { id: 'item-ajeno', counted: 5 },
      ]),
    ).rejects.toThrow(/no pertenece/)

    expect(prismaMock.stockCountItem.update).not.toHaveBeenCalled()
  })
})

// ── Confirm: la validación vive también en la frontera del EFECTO ──────────
// Un negativo ya almacenado (capturado antes del deploy, o metido por el hueco
// de tenant) no debe aplicarse al inventario aunque el update de hoy lo rechace.
describe('confirmStockCount — un negativo almacenado no se aplica', () => {
  const COUNT = 'count-1'
  const VENUE = 'venue-1'

  it('rechaza confirmar si alguna línea contada quedó negativa', async () => {
    prismaMock.stockCount.findFirst.mockResolvedValue({
      id: COUNT,
      venueId: VENUE,
      status: 'IN_PROGRESS',
      items: [
        {
          id: 'item-1',
          productId: 'prod-1',
          rawMaterialId: null,
          rawMaterial: null,
          expected: 10,
          counted: -5, // almacenado ANTES de que el update validara
          countedAt: new Date(),
          product: { id: 'prod-1', name: 'Cerveza', inventory: { id: 'inv-1', currentStock: 10 } },
        },
      ],
    } as any)

    const { confirmStockCount } = await import('@/services/mobile/inventory.mobile.service')
    await expect(confirmStockCount(COUNT, VENUE, 'staff-1')).rejects.toThrow(/no puede ser negativa/)

    // Nada se aplicó al inventario
    expect(prismaMock.inventory.update).not.toHaveBeenCalled()
    expect(prismaMock.stockCount.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED' }) }),
    )
  })
})
