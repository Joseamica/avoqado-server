/**
 * Tests: createOrderWithItems (TPV Cobrar) debe ser idempotente vía externalId
 *
 * Contexto (auditoría 2026-08-12, hallazgo B-11, confirmado por Codex): el
 * endpoint no tenía NINGUNA llave de idempotencia — un retry del cliente tras
 * perder la respuesta creaba una SEGUNDA orden con nuevo `ORD-${Date.now()}`,
 * y en el caso free-cart ($0 cortesía) eso significaba segunda deducción de
 * inventario. El contrato espejo ya existía en el mobile createOrderWithItems:
 * `venueId_externalId` único → repetir devuelve la orden original.
 *
 * El corto-circuito va ANTES de cualquier validación/creación (mismo criterio
 * que el mobile): un retry no debe re-validar nada, solo recuperar su orden.
 */

import { prismaMock } from '../../../__helpers__/setup'

const assertVenueSalesEnabledMock = jest.fn()
jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: (...args: unknown[]) => assertVenueSalesEnabledMock(...args),
}))

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn().mockReturnValue(null) },
}))

import { createOrderWithItems } from '@/services/tpv/order.tpv.service'

const VENUE = 'venue-1'
const baseInput = {
  items: [{ productId: 'p1', quantity: 1 }],
  staffId: 'staff-1',
  taxAmount: 0,
  subtotal: 100,
  total: 100,
} as any

describe('createOrderWithItems (TPV) — idempotencia por externalId', () => {
  beforeEach(() => jest.clearAllMocks())

  // La forma COMPLETA que fetchOrderForTpvResponse devuelve en el camino
  // normal — el retry idempotente debe regresar exactamente esta forma
  // (items/modifiers aplanados, pagos), no solo los escalares de Order.
  const fullExistingOrder = {
    id: 'order-1',
    orderNumber: 'ORD-1',
    venueId: VENUE,
    table: { id: 't-1', number: 4 },
    items: [
      {
        id: 'oi-1',
        productName: 'Coca',
        quantity: 1,
        modifiers: [{ modifier: { id: 'mod-1', name: 'Hielo', price: 0 } }],
        paymentAllocations: [],
      },
    ],
    payments: [{ id: 'pay-1', amount: 100, allocations: [] }],
  }

  it('repetir con el mismo externalId devuelve la orden original SIN crear otra, con la MISMA forma completa', async () => {
    prismaMock.order.findUnique.mockResolvedValue({ id: 'order-1' } as any)
    prismaMock.order.findUniqueOrThrow.mockResolvedValue(fullExistingOrder as any)

    const res = await createOrderWithItems(VENUE, { ...baseInput, externalId: 'tpv-retry-123' })

    expect(prismaMock.order.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId_externalId: { venueId: VENUE, externalId: 'tpv-retry-123' } } }),
    )
    expect(res.id).toBe('order-1')
    expect(res.tableName).toBe('Mesa 4')
    // 🔴 Contrato de forma (auditoría 2026-08-13): la TPV lee items y pagos de
    // la respuesta; un retry que devolvía solo escalares rompía al cliente.
    expect((res as any).items).toHaveLength(1)
    expect((res as any).items[0].modifiers[0]).toMatchObject({ id: 'mod-1', name: 'Hielo' })
    expect((res as any).payments).toHaveLength(1)
    // Corto-circuito ANTES de todo: ni valida venue ni abre transacción.
    expect(assertVenueSalesEnabledMock).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('🛡️ el perdedor de la carrera P2002 devuelve la orden GANADORA en vez de un 500', async () => {
    // Dos retries con el MISMO externalId pasan ambos el pre-check (ninguno
    // había commiteado). El perdedor choca con el UNIQUE (venueId, externalId)
    // dentro de la transacción — antes eso subía como P2002 crudo → 500 → la
    // TPV reintentaba OTRA vez, el loop exacto que la llave vino a matar.
    prismaMock.order.findUnique
      .mockResolvedValueOnce(null as any) // pre-check: aún no existe
      .mockResolvedValueOnce({ id: 'order-winner' } as any) // re-lookup tras P2002
    prismaMock.order.findUniqueOrThrow.mockResolvedValue({ ...fullExistingOrder, id: 'order-winner' } as any)
    prismaMock.staffVenue.findUnique.mockResolvedValue({
      id: 'sv-1',
      active: true,
      staff: { id: 'staff-1', active: true },
    } as any)
    prismaMock.product.findMany.mockResolvedValue([
      { id: 'p1', name: 'Coca', price: 100, venueId: VENUE, category: { name: 'Bebidas' } },
    ] as any)
    prismaMock.discount.findMany.mockResolvedValue([] as any)
    prismaMock.terminal.findFirst.mockResolvedValue(null as any)
    const p2002 = Object.assign(new Error('unique violation'), { code: 'P2002' })
    prismaMock.$transaction.mockRejectedValue(p2002)

    const res = await createOrderWithItems(VENUE, { ...baseInput, externalId: 'tpv-race-1' })

    expect(res.id).toBe('order-winner')
    expect((res as any).items).toHaveLength(1)
  })

  it('externalId nuevo (sin orden previa) sigue al flujo normal de creación', async () => {
    prismaMock.order.findUnique.mockResolvedValue(null as any)
    // Sentinela: cortar el flujo justo DESPUÉS del dedup para no mockear la creación entera.
    assertVenueSalesEnabledMock.mockRejectedValue(new Error('SENTINEL_CONTINUE'))

    await expect(createOrderWithItems(VENUE, { ...baseInput, externalId: 'tpv-nuevo-1' })).rejects.toThrow('SENTINEL_CONTINUE')
    expect(prismaMock.order.findUnique).toHaveBeenCalled()
  })

  it('sin externalId no consulta dedup (compat con clientes viejos)', async () => {
    assertVenueSalesEnabledMock.mockRejectedValue(new Error('SENTINEL_CONTINUE'))

    await expect(createOrderWithItems(VENUE, baseInput)).rejects.toThrow('SENTINEL_CONTINUE')
    expect(prismaMock.order.findUnique).not.toHaveBeenCalled()
  })
})
