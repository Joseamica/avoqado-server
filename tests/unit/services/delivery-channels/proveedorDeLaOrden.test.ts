/**
 * ¿De qué proveedor es este pedido? (T6 del plan «Rappi fase 2»)
 *
 * Lo usa el controlador de la cocina para nombrar la app en «X está desconectada…». Lee SÓLO el `externalId` de la orden
 * (filtrada por negocio) y deja la decisión de qué prefijo cuenta como proveedor a `proveedorDelPedido`.
 */
import prisma from '../../../../src/utils/prismaClient'
import { hasAdapter } from '../../../../src/services/delivery-channels/core/adapterRegistry'
import { proveedorDeLaOrden } from '../../../../src/services/delivery-channels/core/respondToDeliveryOrder.service'

jest.mock('../../../../src/services/delivery-channels/core/adapterRegistry', () => ({
  hasAdapter: jest.fn(() => true),
  adapterFor: jest.fn(),
}))

describe('proveedorDeLaOrden', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(hasAdapter as jest.Mock).mockReturnValue(true)
  })

  it.each([
    ['UBER_EATS:uuid-uber-1', 'UBER_EATS'],
    ['RAPPI:900123', 'RAPPI'],
  ])('«%s» ⇒ %s', async (externalId, esperado) => {
    ;(prisma.order.findFirst as jest.Mock).mockResolvedValue({ externalId })

    await expect(proveedorDeLaOrden('venue1', 'order1')).resolves.toBe(esperado)
  })

  it('🔴 busca la orden DENTRO del negocio (nunca el pedido de otro) y sólo pide el externalId', async () => {
    ;(prisma.order.findFirst as jest.Mock).mockResolvedValue({ externalId: 'RAPPI:1' })

    await proveedorDeLaOrden('venue1', 'order1')

    expect(prisma.order.findFirst).toHaveBeenCalledWith({
      where: { id: 'order1', venueId: 'venue1' },
      select: { externalId: true },
    })
  })

  it.each([
    ['la orden no existe en ese negocio', null],
    ['una venta que no es de delivery', { externalId: null }],
    ['un externalId sin prefijo de proveedor', { externalId: 'abc123' }],
  ])('%s ⇒ null (el controlador usa el nombre neutro)', async (_caso, orden) => {
    ;(prisma.order.findFirst as jest.Mock).mockResolvedValue(orden)

    await expect(proveedorDeLaOrden('venue1', 'order1')).resolves.toBeNull()
  })

  it('un proveedor sin adaptador registrado ⇒ null (misma regla que `proveedorDelPedido`)', async () => {
    ;(prisma.order.findFirst as jest.Mock).mockResolvedValue({ externalId: 'DIDI_FOOD:77' })
    ;(hasAdapter as jest.Mock).mockReturnValue(false)

    await expect(proveedorDeLaOrden('venue1', 'order1')).resolves.toBeNull()
  })
})
