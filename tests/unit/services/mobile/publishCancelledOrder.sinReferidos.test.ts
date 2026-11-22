/**
 * hz:e82938e1:D36 (Codex r2 #2). La limpieza de ventas de Cobrar comprueba BAJO EL CANDADO que la venta no tiene referidos ni cobros,
 * y publica la anulación con `sinReferidos`: un referido capturado en el instante después de anular se queda PENDING para que el cobro
 * tardío lo califique. Cualquier otra anulación sigue mandando los referidos pendientes a VOID, como siempre.
 */
const aviso = { broadcastToVenue: jest.fn() }
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => aviso) } }))
jest.mock('@/services/referrals/referralRefund.service', () => ({ onOrderCancelled: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import { onOrderCancelled } from '@/services/referrals/referralRefund.service'
import { prismaMock } from '../../../__helpers__/setup'
import { publishCancelledOrder } from '@/services/mobile/order.mobile.service'

const anulada = {
  orderId: 'order-1',
  table: null,
  tables: [],
  hadBoundTable: false,
  tpvTableFreed: false,
  affectedRefs: [],
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.order.findFirst.mockResolvedValue({ status: 'CANCELLED' } as any)
})

const estadoAvisado = () =>
  aviso.broadcastToVenue.mock.calls.filter(([, evento]: any[]) => evento === 'order_updated').map(([, , datos]: any[]) => datos.status)

describe('publishCancelledOrder · referidos', () => {
  it('🔴 con `sinReferidos` (la limpieza de Cobrar) no manda a VOID los referidos de la venta', async () => {
    await publishCancelledOrder('venue-1', anulada as any, undefined, 'limpieza', undefined, { bitacoraEnLaTx: true, sinReferidos: true })
    expect(onOrderCancelled).not.toHaveBeenCalled()
  })

  it('regresión: cualquier otra anulación sigue mandando a VOID los referidos pendientes de la venta', async () => {
    await publishCancelledOrder('venue-1', anulada as any, 'staff-1', 'cliente se fue')
    expect(onOrderCancelled).toHaveBeenCalledWith({ orderId: 'order-1', venueId: 'venue-1' })
  })
})

// hz:e82938e1:D36 (founder «B», Codex r5 #3): el aviso sale después del commit; si en ese hueco un cobro tardío ya reabrió la venta y
// avisó «COMPLETED», el de la anulación no puede llegar después diciendo «CANCELLED».
describe('publishCancelledOrder · el aviso dice el estado de la venta en ese momento', () => {
  it('regresión: la venta sigue anulada ⇒ avisa CANCELLED, como siempre', async () => {
    await publishCancelledOrder('venue-1', anulada as any, 'staff-1', 'cliente se fue')
    expect(estadoAvisado()).toEqual(['CANCELLED'])
    expect(prismaMock.order.findFirst).toHaveBeenCalledWith({ where: { id: 'order-1', venueId: 'venue-1' }, select: { status: true } })
  })

  it('🔴 un cobro tardío ya la reabrió y la saldó ⇒ avisa COMPLETED, no CANCELLED', async () => {
    prismaMock.order.findFirst.mockResolvedValue({ status: 'COMPLETED' } as any)
    await publishCancelledOrder('venue-1', anulada as any, undefined, 'limpieza', undefined, { bitacoraEnLaTx: true, sinReferidos: true })
    expect(estadoAvisado()).toEqual(['COMPLETED'])
  })

  it('🔴 si releerla falla (o ya no está) ⇒ avisa CANCELLED: el aviso nunca se pierde', async () => {
    prismaMock.order.findFirst.mockRejectedValueOnce(new Error('se cayó la conexión'))
    await publishCancelledOrder('venue-1', anulada as any)
    prismaMock.order.findFirst.mockResolvedValueOnce(null)
    await publishCancelledOrder('venue-1', anulada as any)
    expect(estadoAvisado()).toEqual(['CANCELLED', 'CANCELLED'])
  })
})
