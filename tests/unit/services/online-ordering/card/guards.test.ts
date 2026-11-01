// tests/unit/services/online-ordering/card/guards.test.ts
import { prismaMock } from '@tests/__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'
import {
  assertCardOrderMoneyFrozenInTx,
  assertCardRefundGoesThroughOnlineOrders,
  assertNotCardOnlineOrderInTx,
  avisarCobroDobleSobrePedidoConTarjeta,
} from '@/services/online-ordering/card/guards'

const I = { venueId: 'v1', orderId: 'o1' }
const card = (status: string | null) =>
  ({ paymentMode: 'CARD_ONLINE', charge: status ? { id: 'ch1', status, paymentIntentId: 'pi_1' } : null }) as any

beforeEach(() => {
  prismaMock.onlineOrder.findFirst.mockReset()
  prismaMock.payment.findFirst.mockReset()
  ;(logAction as jest.Mock).mockClear()
})

describe('assertNotCardOnlineOrderInTx', () => {
  it('pedido de tarjeta → 409 ONLINE_ORDER_PAID_BY_CARD', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(card('AUTHORIZED'))
    await expect(assertNotCardOnlineOrderInTx(prismaMock, I)).rejects.toMatchObject({
      statusCode: 409,
      code: 'ONLINE_ORDER_PAID_BY_CARD',
      message: 'Este pedido ya se pagó con tarjeta en línea. No lo cobres en caja.',
    })
    expect(prismaMock.onlineOrder.findFirst.mock.calls[0][0]!.where).toEqual({ orderId: 'o1', venueId: 'v1' })
  })

  it('pagar al recoger o cuenta normal → pasa (regresión)', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue({ paymentMode: 'PAY_AT_PICKUP', charge: null } as any)
    await expect(assertNotCardOnlineOrderInTx(prismaMock, I)).resolves.toBeUndefined()
    prismaMock.onlineOrder.findFirst.mockResolvedValue(null)
    await expect(assertNotCardOnlineOrderInTx(prismaMock, I)).resolves.toBeUndefined()
  })
})

describe('assertCardOrderMoneyFrozenInTx', () => {
  it.each(['AUTHORIZED', 'CAPTURING', 'RELEASING'])('cargo %s → 409 con el texto del total fijo', async status => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(card(status))
    await expect(assertCardOrderMoneyFrozenInTx(prismaMock, I)).rejects.toMatchObject({
      statusCode: 409,
      code: 'ONLINE_ORDER_PAID_BY_CARD',
      message: 'Este pedido se pagó con tarjeta en línea por un total fijo; no se puede modificar.',
    })
  })

  it('cargo CAPTURED → pasa (mandan las reglas de cuenta cobrada); pagar al recoger → pasa', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(card('CAPTURED'))
    await expect(assertCardOrderMoneyFrozenInTx(prismaMock, I)).resolves.toBeUndefined()
    prismaMock.onlineOrder.findFirst.mockResolvedValue({ paymentMode: 'PAY_AT_PICKUP', charge: null } as any)
    await expect(assertCardOrderMoneyFrozenInTx(prismaMock, I)).resolves.toBeUndefined()
  })
})

describe('assertCardRefundGoesThroughOnlineOrders', () => {
  const R = { venueId: 'v1', paymentId: 'p1' }

  it('el cobro de Stripe del cargo sin viaOnlineOrders → 409 ONLINE_ORDER_REFUND_VIA_ONLINE_ORDERS', async () => {
    prismaMock.payment.findFirst.mockResolvedValue({ orderId: 'o1', processorId: 'pi_1' } as any)
    prismaMock.onlineOrder.findFirst.mockResolvedValue(card('CAPTURED'))
    await expect(assertCardRefundGoesThroughOnlineOrders(prismaMock, R)).rejects.toMatchObject({
      statusCode: 409,
      code: 'ONLINE_ORDER_REFUND_VIA_ONLINE_ORDERS',
      message: 'Devuelve este pago desde Pedidos en línea para que regrese a la tarjeta del cliente.',
    })
  })

  it('con viaOnlineOrders pasa sin leer nada', async () => {
    await expect(assertCardRefundGoesThroughOnlineOrders(prismaMock, { ...R, viaOnlineOrders: true })).resolves.toBeUndefined()
    expect(prismaMock.payment.findFirst).not.toHaveBeenCalled()
  })

  it('otro pago de la misma cuenta (cobro tardío de la TPV) sigue su camino: sólo el de Stripe está protegido', async () => {
    prismaMock.payment.findFirst.mockResolvedValue({ orderId: 'o1', processorId: 'blumon-123' } as any)
    prismaMock.onlineOrder.findFirst.mockResolvedValue(card('CAPTURED'))
    await expect(assertCardRefundGoesThroughOnlineOrders(prismaMock, R)).resolves.toBeUndefined()
  })
})

describe('avisarCobroDobleSobrePedidoConTarjeta', () => {
  const D = { ...I, paymentId: 'p9', staffId: 's1', source: 'TPV' }

  it('cargo CAPTURED → bitácora ONLINE_ORDER_CARD_DOUBLE_PAYMENT', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(card('CAPTURED'))
    await avisarCobroDobleSobrePedidoConTarjeta(prismaMock, D)
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ONLINE_ORDER_CARD_DOUBLE_PAYMENT',
        venueId: 'v1',
        entityId: 'o1',
        data: { paymentId: 'p9', chargeId: 'ch1', source: 'TPV' },
      }),
    )
  })

  it('cargo sin cobrar o cuenta normal → nada; un error de lectura no lanza', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(card('AUTHORIZED'))
    await avisarCobroDobleSobrePedidoConTarjeta(prismaMock, D)
    prismaMock.onlineOrder.findFirst.mockRejectedValue(new Error('db'))
    await expect(avisarCobroDobleSobrePedidoConTarjeta(prismaMock, D)).resolves.toBeUndefined()
    expect(logAction).not.toHaveBeenCalled()
  })
})
