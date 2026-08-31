/**
 * 🔴 DINERO. Canjear un premio baja lo que el cliente paga: un canje de más es
 * producto regalado, y un doble canje es el mismo café gratis cobrado dos veces
 * contra la misma cartilla.
 */
import { redeemStampReward } from '../../../../src/services/wallet/redeemStampReward.service'
import { prismaMock } from '../../../__helpers__/setup'

// 🔴 Crear la fila del descuento NO baja la cuenta: los totales de la orden son
// campos calculados. Se mockea el recálculo para poder exigir que se invoque.
jest.mock('@/services/mobile/comp-item.mobile.service', () => ({
  recalculateOrderTotals: jest.fn().mockResolvedValue({ id: 'o1', total: 200, discountAmount: 50 }),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))

import { recalculateOrderTotals } from '@/services/mobile/comp-item.mobile.service'
import { logAction } from '@/services/dashboard/activity-log.service'

const ORDEN = {
  id: 'o1',
  venueId: 'v1',
  customerId: 'c1',
  total: 250,
  subtotal: 250,
  discountAmount: 0,
  paymentStatus: 'PENDING',
  paidAmount: 0,
}

const PREMIO_MONTO = {
  id: 'rw1',
  venueId: 'v1',
  customerId: 'c1',
  status: 'PENDING',
  rewardType: 'FIXED_AMOUNT',
  rewardValue: 50,
  rewardProductId: null,
  rewardLabel: '$50 de descuento',
  expiresAt: null,
}

describe('redeemStampReward', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.order.findFirst.mockResolvedValue(ORDEN as any)
    prismaMock.stampReward.findFirst.mockResolvedValue(PREMIO_MONTO as any)
    prismaMock.stampReward.updateMany.mockResolvedValue({ count: 1 } as any)
    prismaMock.orderDiscount.create.mockResolvedValue({ id: 'od1' } as any)
    prismaMock.stampReward.update.mockResolvedValue({} as any)
  })

  it('🔴 un premio de monto fijo crea el descuento en la cuenta', async () => {
    const r = await redeemStampReward('v1', 'o1', 'rw1')

    expect(r.discountAmount).toBe(50)
    expect(prismaMock.orderDiscount.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orderId: 'o1', type: 'FIXED_AMOUNT' }),
      }),
    )
  })

  it('🔴 el MISMO premio no se puede canjear dos veces', async () => {
    // Dos cajeros tocan "canjear" a la vez. El chequeo de estado corre ANTES de la
    // transacción, así que los dos lo ven PENDING: lo único que separa un café
    // regalado de dos es que el cambio de estado sea CONDICIONAL. Aquí se simula que
    // el otro ganó la carrera — el UPDATE no encuentra la fila en PENDING.
    prismaMock.stampReward.updateMany.mockResolvedValue({ count: 0 } as any)

    await expect(redeemStampReward('v1', 'o1', 'rw1')).rejects.toThrow(/ya/i)

    // Y lo que de verdad importa: NO nació un segundo descuento.
    expect(prismaMock.orderDiscount.create).not.toHaveBeenCalled()
  })

  it('🔴 un premio de PORCENTAJE se calcula sobre la cuenta, no es un monto', async () => {
    // 20% de una cuenta de 250 son 50 pesos. Tratar el 20 como pesos cobraría de
    // menos aquí, y de MÁS en una cuenta chica — es el error que hace que un
    // porcentaje mal aplicado pase desapercibido hasta el corte.
    prismaMock.stampReward.findFirst.mockResolvedValue({
      ...PREMIO_MONTO,
      rewardType: 'PERCENTAGE',
      rewardValue: 20,
      rewardLabel: '20% de descuento',
    } as any)

    const r = await redeemStampReward('v1', 'o1', 'rw1')

    expect(r.discountAmount).toBe(50)
  })

  it('🔴 un premio de PRODUCTO GRATIS descuenta el artículo MÁS CARO de la cuenta', async () => {
    // Decisión del founder (D10), tomada de Square: si el cliente pide algo más caro
    // que el producto prometido, se le descuenta lo más caro y no paga diferencia.
    // Descontar el precio de catálogo lo dejaría pagando la diferencia de un premio
    // que ya se ganó.
    prismaMock.stampReward.findFirst.mockResolvedValue({
      ...PREMIO_MONTO,
      rewardType: 'FREE_PRODUCT',
      rewardValue: null,
      rewardProductId: 'p-cafe',
      rewardLabel: 'Un café gratis',
    } as any)
    prismaMock.orderItem.findMany.mockResolvedValue([
      { id: 'oi1', unitPrice: 45, quantity: 1 },
      { id: 'oi2', unitPrice: 90, quantity: 1 },
    ] as any)

    const r = await redeemStampReward('v1', 'o1', 'rw1')

    expect(r.discountAmount).toBe(90)
  })

  it('🔴 el descuento NUNCA excede la cuenta', async () => {
    // Un premio de $500 sobre una cuenta de $250. Sin tope, el descuento deja la
    // orden en negativo: el negocio no sólo regala el consumo, queda debiendo.
    prismaMock.stampReward.findFirst.mockResolvedValue({ ...PREMIO_MONTO, rewardValue: 500 } as any)

    const r = await redeemStampReward('v1', 'o1', 'rw1')

    expect(r.discountAmount).toBe(250)
  })

  it('🔴 sobre una cuenta en CERO no se quema el premio', async () => {
    // Canjear aquí gastaría el premio sin darle nada al cliente — se pierde un café
    // gratis que ya se había ganado, y sin forma de devolverlo desde el mostrador.
    prismaMock.order.findFirst.mockResolvedValue({ ...ORDEN, subtotal: 0, total: 0 } as any)

    await expect(redeemStampReward('v1', 'o1', 'rw1')).rejects.toThrow(/cuenta/i)

    expect(prismaMock.stampReward.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.orderDiscount.create).not.toHaveBeenCalled()
  })

  describe('lo que NO se puede canjear', () => {
    it('🔴 una cuenta ya pagada no se toca', async () => {
      // El dinero ya entró. Meter un descuento después deja el cobro y la cuenta
      // discrepando, y el corte no cuadra al final del turno.
      prismaMock.order.findFirst.mockResolvedValue({ ...ORDEN, paymentStatus: 'PAID', paidAmount: 250 } as any)

      await expect(redeemStampReward('v1', 'o1', 'rw1')).rejects.toThrow(/pagada/i)

      expect(prismaMock.stampReward.updateMany).not.toHaveBeenCalled()
    })

    it('🔴 tampoco una cuenta con un abono parcial', async () => {
      // Mismo problema: parte del dinero ya entró contra un total que cambiaría.
      prismaMock.order.findFirst.mockResolvedValue({ ...ORDEN, paymentStatus: 'PARTIAL', paidAmount: 100 } as any)

      await expect(redeemStampReward('v1', 'o1', 'rw1')).rejects.toThrow(/pagada/i)
    })

    it('🔴 un premio de OTRO negocio no existe para este', async () => {
      // La consulta filtra por venue, así que un premio ajeno llega como null. Sin
      // ese filtro, el premio de una sucursal bajaría la cuenta de otra.
      prismaMock.stampReward.findFirst.mockResolvedValue(null)

      await expect(redeemStampReward('v1', 'o1', 'ajeno')).rejects.toThrow(/premio/i)
    })

    it('🔴 un premio de OTRO cliente no se puede quemar en esta cuenta', async () => {
      prismaMock.order.findFirst.mockResolvedValue({ ...ORDEN, customerId: 'cliente-de-la-cuenta' } as any)
      prismaMock.stampReward.findFirst.mockImplementation((async (args: any) => {
        if (args.where.customerId === 'cliente-de-la-cuenta') return null
        return { ...PREMIO_MONTO, customerId: 'cliente-del-premio' }
      }) as any)

      await expect(redeemStampReward('v1', 'o1', 'rw1')).rejects.toThrow(/premio/i)
      expect(prismaMock.orderDiscount.create).not.toHaveBeenCalled()
    })

    it('un premio ya canjeado se rechaza sin llegar a la transacción', async () => {
      prismaMock.stampReward.findFirst.mockResolvedValue({ ...PREMIO_MONTO, status: 'REDEEMED' } as any)

      await expect(redeemStampReward('v1', 'o1', 'rw1')).rejects.toThrow(/ya/i)

      expect(prismaMock.stampReward.updateMany).not.toHaveBeenCalled()
    })

    it('🔴 un premio VENCIDO no se canjea', async () => {
      // Si caduca y aun así se canjea, la fecha de vencimiento es decorativa — y el
      // negocio que puso un plazo descubre que nunca se respetó.
      prismaMock.stampReward.findFirst.mockResolvedValue({
        ...PREMIO_MONTO,
        expiresAt: new Date(Date.now() - 86_400_000),
      } as any)

      await expect(redeemStampReward('v1', 'o1', 'rw1')).rejects.toThrow(/venc/i)
    })

    it('una orden que no existe se rechaza en vez de reventar', async () => {
      prismaMock.order.findFirst.mockResolvedValue(null)

      await expect(redeemStampReward('v1', 'inexistente', 'rw1')).rejects.toThrow(/orden/i)
    })
  })

  it('🔴 recalcula los totales: si no, el descuento existe pero la cuenta no baja', async () => {
    // Es el defecto que dejaría al cliente pagando completo con su premio quemado.
    // La fila del descuento por sí sola no mueve `total` ni `discountAmount`.
    await redeemStampReward('v1', 'o1', 'rw1')

    expect(recalculateOrderTotals).toHaveBeenCalledWith('o1', expect.anything(), expect.anything())
  })

  it('🔴 deja rastro en la bitácora de quién regaló qué', async () => {
    // Un premio es producto que sale sin cobrarse. Sin registro, no hay forma de
    // revisar por qué el inventario no cuadra al final del mes.
    await redeemStampReward('v1', 'o1', 'rw1', { staffId: 'staff9' })

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'STAMP_REWARD_REDEEMED',
        venueId: 'v1',
        staffId: 'staff9',
      }),
    )
  })
})
