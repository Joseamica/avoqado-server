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

  it('repetir con el mismo externalId devuelve la orden original SIN crear otra', async () => {
    const existing = { id: 'order-1', orderNumber: 'ORD-1', venueId: VENUE, table: { number: 4 } }
    prismaMock.order.findUnique.mockResolvedValue(existing as any)

    const res = await createOrderWithItems(VENUE, { ...baseInput, externalId: 'tpv-retry-123' })

    expect(prismaMock.order.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId_externalId: { venueId: VENUE, externalId: 'tpv-retry-123' } } }),
    )
    expect(res.id).toBe('order-1')
    expect(res.tableName).toBe('Mesa 4')
    // Corto-circuito ANTES de todo: ni valida venue ni abre transacción.
    expect(assertVenueSalesEnabledMock).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
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
