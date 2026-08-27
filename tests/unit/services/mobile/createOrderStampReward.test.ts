/**
 * 🔴 DINERO. Aplicar el premio de una cartilla AL CREAR la cuenta, no después.
 *
 * El punto de venta cobra el total que le devuelve el SERVIDOR, no el que calculó el
 * carrito (`adoptarTotalDelServer` en PaymentFlowViewModel). Por eso el descuento tiene
 * que existir en el momento en que la orden nace: con dos llamadas —crear y luego
 * canjear— queda una ventana en la que la cuenta existe con el total sin descontar, y
 * si el cobro entra ahí el cliente paga de más.
 *
 * Y la otra mitad: si el premio NO se puede aplicar, la venta no se detiene, pero
 * tampoco puede mentir sobre el total. El cajero tiene que enterarse.
 */
jest.mock('@/services/wallet/redeemStampReward.service', () => ({
  redeemStampReward: jest.fn(),
}))

import { redeemStampReward } from '@/services/wallet/redeemStampReward.service'

describe('crear la orden con un premio de cartilla', () => {
  beforeEach(() => jest.clearAllMocks())

  it('🔴 el premio se canjea contra la orden RECIÉN creada', async () => {
    // Es lo que garantiza que el total que viaja al aparato ya venga descontado.
    ;(redeemStampReward as jest.Mock).mockResolvedValue({ discountAmount: 50, rewardLabel: 'Un café gratis', order: {} })

    const { applyStampRewardToNewOrder } = await import('@/services/mobile/order.mobile.service')
    const r = await applyStampRewardToNewOrder('v1', 'orden-recien-creada', 'rw1', 'staff9')

    expect(redeemStampReward).toHaveBeenCalledWith('v1', 'orden-recien-creada', 'rw1', { staffId: 'staff9' })
    expect(r).toEqual({ applied: true, discountAmount: 50, rewardLabel: 'Un café gratis' })
  })

  it('🔴 si el premio NO se puede aplicar, la venta sigue — pero lo DICE', async () => {
    // Tumbar la creación de la orden dejaría al cajero sin poder cobrar por un premio.
    // Aplicarlo en silencio dejaría al cliente pagando completo sin que nadie se
    // entere. La única salida honesta es cobrar el total real y avisar.
    ;(redeemStampReward as jest.Mock).mockRejectedValue(new Error('Este premio ya fue canjeado.'))

    const { applyStampRewardToNewOrder } = await import('@/services/mobile/order.mobile.service')
    const r = await applyStampRewardToNewOrder('v1', 'o1', 'rw-usado', 'staff9')

    expect(r.applied).toBe(false)
    expect(r.reason).toMatch(/ya fue canjeado/i)
  })

  it('sin premio no se llama a nada', async () => {
    // El caso normal: la inmensa mayoría de las ventas no traen premio. No puede
    // costar ni una consulta de más.
    const { applyStampRewardToNewOrder } = await import('@/services/mobile/order.mobile.service')
    const r = await applyStampRewardToNewOrder('v1', 'o1', null, 'staff9')

    expect(redeemStampReward).not.toHaveBeenCalled()
    expect(r.applied).toBe(false)
  })
})

describe('el total que viaja al aparato', () => {
  const fuente = require('fs').readFileSync(
    require('path').join(__dirname, '../../../../src/services/mobile/order.mobile.service.ts'),
    'utf8',
  )

  it('🔴 tras aplicar el premio, la orden se RELEE antes de devolverla', () => {
    // Es lo que se olvida y lo que cuesta dinero: `order` es el objeto en memoria de
    // ANTES del descuento. Devolverlo tal cual haría que el punto de venta cobre el
    // total sin descontar — el premio quemado y el cliente pagando completo.
    //
    // Prueba estructural a propósito: montar `createOrderWithItems` entera en un test
    // unitario cuesta más de lo que protege (arrastra sockets, cocina, promociones).
    // Lo que aquí importa es que la relectura EXISTA y esté atada a que se haya
    // aplicado el premio.
    const i = fuente.indexOf('applyStampRewardToNewOrder(venueId, order.id')
    expect(i).toBeGreaterThan(-1)

    const despues = fuente.slice(i, i + 900)
    expect(despues).toMatch(/stampReward\.applied[\s\S]*prisma\.order\.findUnique/)
  })

  it('🔴 lo que se devuelve es la orden RELEÍDA, no la original', () => {
    // Releer y luego devolver la vieja sería el mismo defecto con un paso extra.
    expect(fuente).toMatch(/toCreatedOrderResponse\(orderFinal/)
  })

  it('el aviso en tiempo real también lleva el total ya descontado', () => {
    // Si el broadcast manda el total viejo, la comanda y las pantallas de cocina
    // muestran una cifra que no coincide con lo que el cliente paga.
    const i = fuente.indexOf('SocketEventType.ORDER_CREATED')
    expect(fuente.slice(i, i + 400)).toMatch(/total: Number\(orderFinal\.total\)/)
  })

  it('sin premio, la respuesta NO gana campos nuevos', () => {
    // La inmensa mayoría de las ventas no trae premio, y el contrato con iOS, Android
    // y el TPV tiene que quedar byte a byte como estaba.
    expect(fuente).toMatch(/input\.stampRewardId \? \{ stampReward \} : \{\}/)
  })
})
