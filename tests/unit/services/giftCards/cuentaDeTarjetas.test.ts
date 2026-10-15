import { esCuentaDeTarjetas, esCuentaDeTarjetasEnTx, rechazarSiEsCuentaDeTarjetas } from '@/services/giftCards/cuentaDeTarjetas'
import * as contrato from '@/services/giftCards/giftCardOrder.service'
import { prismaMock } from '../../../__helpers__/setup'

describe('cuenta de tarjetas — guardias', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.orderItem.findFirst.mockReset()
  })

  it('esCuentaDeTarjetas: todas las líneas con sobre; vacía o mixta NO lo es', () => {
    expect(esCuentaDeTarjetas([{ giftCardId: 'gc-1' }, { giftCardId: 'gc-2' }])).toBe(true)
    expect(esCuentaDeTarjetas([])).toBe(false)
    expect(esCuentaDeTarjetas([{ giftCardId: 'gc-1' }, { giftCardId: null }])).toBe(false)
  })

  it('esCuentaDeTarjetasEnTx busca UN renglón con sobre de esa cuenta, con la transacción recibida', async () => {
    prismaMock.orderItem.findFirst.mockResolvedValue({ giftCardId: 'gc-1' })
    await expect(esCuentaDeTarjetasEnTx(prismaMock, 'order-1')).resolves.toBe(true)
    expect(prismaMock.orderItem.findFirst).toHaveBeenCalledWith({
      where: { orderId: 'order-1', giftCardId: { not: null } },
      select: { giftCardId: true },
    })
  })

  it('una cuenta normal no es de tarjetas (y un renglón sin giftCardId tampoco cuenta)', async () => {
    prismaMock.orderItem.findFirst.mockResolvedValue(null)
    await expect(esCuentaDeTarjetasEnTx(prismaMock, 'order-1')).resolves.toBe(false)
    prismaMock.orderItem.findFirst.mockResolvedValue({ id: 'oi-1', productId: 'p-1' })
    await expect(esCuentaDeTarjetasEnTx(prismaMock, 'order-1')).resolves.toBe(false)
  })

  it('rechazarSiEsCuentaDeTarjetas: 409 GIFT_CARD_ORDER_IMMUTABLE con la acción en español', async () => {
    prismaMock.orderItem.findFirst.mockResolvedValue({ giftCardId: 'gc-1' })
    await expect(rechazarSiEsCuentaDeTarjetas(prismaMock, 'order-1', 'descuentos')).rejects.toMatchObject({
      code: 'GIFT_CARD_ORDER_IMMUTABLE',
      statusCode: 409,
      message: 'Esta cuenta es de tarjetas de regalo y no admite descuentos. Si hay un error, cancélala y crea otra.',
    })
    prismaMock.orderItem.findFirst.mockResolvedValue(null)
    await expect(rechazarSiEsCuentaDeTarjetas(prismaMock, 'order-2', 'descuentos')).resolves.toBeUndefined()
  })

  it('el servicio de la cuenta re-exporta las guardias con los nombres del contrato', () => {
    expect(contrato.rechazarSiEsCuentaDeTarjetas).toBe(rechazarSiEsCuentaDeTarjetas)
    expect(contrato.esCuentaDeTarjetas).toBe(esCuentaDeTarjetas)
  })
})
