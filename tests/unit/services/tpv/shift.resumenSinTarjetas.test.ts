/**
 * S0.2 (tarjetas 1b): la lista de turnos de la TPV (`getShiftsSummary`) no cuenta la cuenta de tarjetas como orden. Las dos mitades
 * de `totalOrders` (las órdenes del turno y las huérfanas) llevan el MISMO predicado, `WHERE_ORDEN_SIN_TARJETAS`, que ya usa el resto
 * de los reportes. El `totalSales` sin tarjetas lo fija `shift.totalSalesSinTarjetas.test.ts`.
 */
import { getShiftsSummary } from '@/services/tpv/shift.tpv.service'
import { prismaMock } from '@tests/__helpers__/setup'

describe('getShiftsSummary · órdenes sin la cuenta de tarjetas (S0.2)', () => {
  it('getShiftsSummary no cuenta cuentas de tarjetas en totalOrders ni en orphanOrderCount', async () => {
    prismaMock.shift.findMany.mockResolvedValue([])
    prismaMock.payment.findMany.mockResolvedValue([])
    prismaMock.order.count.mockResolvedValue(0)
    prismaMock.review.count.mockResolvedValue(0)
    await getShiftsSummary('venue-1', {})
    const sinTarjetas = { items: { none: { giftCardId: { not: null } } } }
    expect(prismaMock.shift.findMany.mock.calls[0][0].include.orders.where).toMatchObject({ status: 'COMPLETED', ...sinTarjetas })
    expect(prismaMock.order.count.mock.calls[0][0].where).toMatchObject({
      venueId: 'venue-1',
      shiftId: null,
      status: 'COMPLETED',
      ...sinTarjetas,
    })
  })
})
