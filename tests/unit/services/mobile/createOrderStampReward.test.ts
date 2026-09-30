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
    // Tolera saltos de línea: prettier parte la llamada cuando crece.
    const i = fuente.search(/applyStampRewardToNewOrder\(\s*venueId,\s*order\.id/)
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

describe('el premio al REINTENTAR la creación (misma externalId)', () => {
  const { prismaMock } = require('../../../__helpers__/setup')
  const activity = require('@/services/dashboard/activity-log.service')

  beforeEach(() => {
    jest.clearAllMocks()
    jest.spyOn(activity, 'logAction').mockResolvedValue(undefined)
  })

  it('🔴 el resultado se lee con un JOIN directo, sin truncar los descuentos de la orden', async () => {
    // Con `take: 100` sobre los descuentos, una venta con 100 renglones descontados escondía el
    // premio y el reintento lo reportaba como no aplicado (hallazgo P2 de Codex, ronda 2).
    prismaMock.$queryRaw.mockResolvedValue([{ rewardLabel: '$30 de premio', amount: 30 }])

    const { stampRewardOutcomeForExistingOrder } = await import('@/services/mobile/order.mobile.service')
    const r = await stampRewardOutcomeForExistingOrder('v1', 'orden-existente')

    expect(r).toEqual({ applied: true, discountAmount: 30, rewardLabel: '$30 de premio' })
    expect(prismaMock.orderDiscount.findMany).not.toHaveBeenCalled()
  })

  it('si el primer intento YA lo canjeó, el reintento lo dice y no vuelve a canjear', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ rewardLabel: 'Premio', amount: 30 }])

    const { ensureStampRewardOnExistingOrder } = await import('@/services/mobile/order.mobile.service')
    const r = await ensureStampRewardOnExistingOrder('v1', 'o1', 'rw1', 'staff9', 3000)

    expect(r).toEqual({ applied: true, discountAmount: 30, rewardLabel: 'Premio' })
    expect(redeemStampReward).not.toHaveBeenCalled()
    expect(activity.logAction).not.toHaveBeenCalled()
  })

  it('🔴 si el primer intento se cayó ANTES de canjearlo, el reintento lo canjea ahora', async () => {
    // Sin esto, la caja cobraba el precio completo y el premio quedaba sin usar sobre una orden
    // que ya existía (hallazgo P1 de Codex, ronda 2).
    prismaMock.$queryRaw.mockResolvedValue([])
    ;(redeemStampReward as jest.Mock).mockResolvedValue({ discountAmount: 30, rewardLabel: 'Premio', order: {} })

    const { ensureStampRewardOnExistingOrder } = await import('@/services/mobile/order.mobile.service')
    const r = await ensureStampRewardOnExistingOrder('v1', 'o1', 'rw1', 'staff9', 3000)

    expect(redeemStampReward).toHaveBeenCalledWith('v1', 'o1', 'rw1', { staffId: 'staff9' })
    expect(r.applied).toBe(true)
    expect(activity.logAction).not.toHaveBeenCalled()
  })

  it('🔴 dos intentos a la vez: el que pierde la carrera responde lo que ganó el otro', async () => {
    // El canje es condicional: sólo uno lo quema. El otro recibe «ya fue canjeado», pero en ESTA
    // orden sí quedó aplicado — responder «no aplicado» haría que la caja cobre completo.
    prismaMock.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ rewardLabel: 'Premio', amount: 30 }])
    ;(redeemStampReward as jest.Mock).mockRejectedValue(new Error('Este premio ya fue canjeado.'))

    const { ensureStampRewardOnExistingOrder } = await import('@/services/mobile/order.mobile.service')
    const r = await ensureStampRewardOnExistingOrder('v1', 'o1', 'rw1', 'staff9', 3000)

    expect(r).toEqual({ applied: true, discountAmount: 30, rewardLabel: 'Premio' })
    expect(activity.logAction).not.toHaveBeenCalled()
  })

  it('🔴 si de verdad no se pudo aplicar, lo dice UNA vez en la bitácora', async () => {
    prismaMock.$queryRaw.mockResolvedValue([])
    ;(redeemStampReward as jest.Mock).mockRejectedValue(new Error('Este premio ya venció.'))

    const { ensureStampRewardOnExistingOrder } = await import('@/services/mobile/order.mobile.service')
    const r = await ensureStampRewardOnExistingOrder('v1', 'o1', 'rw1', 'staff9', 3000)

    expect(r.applied).toBe(false)
    expect(r.reason).toMatch(/venció/)
    expect(activity.logAction).toHaveBeenCalledTimes(1)
    expect(activity.logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'STAMP_REWARD_NOT_AS_CHARGED',
        entityId: 'o1',
        data: expect.objectContaining({ expectedCents: 3000, confirmedCents: 0 }),
      }),
    )
  })

  it('🔴 LAS DOS salidas de idempotencia (atajo y choque de índice único) responden el premio', () => {
    const fuente = require('fs').readFileSync(
      require('path').join(__dirname, '../../../../src/services/mobile/order.mobile.service.ts'),
      'utf8',
    )
    const atajo = fuente.indexOf('Duplicate createOrderWithItems detected')
    const choque = fuente.indexOf('Concurrent duplicate blocked by unique index')
    expect(atajo).toBeGreaterThan(-1)
    expect(choque).toBeGreaterThan(-1)
    expect(fuente.slice(atajo, atajo + 900)).toMatch(/ensureStampRewardOnExistingOrder\(/)
    expect(fuente.slice(choque, choque + 900)).toMatch(/ensureStampRewardOnExistingOrder\(/)
  })

  it('🔴 si el reintento canjea el premio AHORA, las dos salidas responden la orden RELEÍDA (Codex, fusión 30-sep)', () => {
    // La orden se leyó ANTES de canjear: devolverla tal cual respondería $100 con `applied: true` sobre una base de $70,
    // y la caja cobraría completo con el premio ya quemado. Mismo defecto que el camino normal ya cierra con `orderFinal`.
    const fuente = require('fs').readFileSync(
      require('path').join(__dirname, '../../../../src/services/mobile/order.mobile.service.ts'),
      'utf8',
    )
    for (const marca of ['Duplicate createOrderWithItems detected', 'Concurrent duplicate blocked by unique index']) {
      const tramo = fuente.slice(fuente.indexOf(marca), fuente.indexOf(marca) + 1400)
      expect(tramo).toMatch(/ensureStampRewardOnExistingOrder\([\s\S]*stampReward\.applied[\s\S]*prisma\.order\.findUnique\(/)
      expect(tramo).toMatch(/toCreatedOrderResponse\(ordenReleida\)/)
    }
  })
})

describe('el premio que NO salió como la caja lo cobró deja rastro', () => {
  const activity = require('@/services/dashboard/activity-log.service')

  beforeEach(() => {
    jest.clearAllMocks()
    jest.spyOn(activity, 'logAction').mockResolvedValue(undefined)
  })

  it('🔴 si la caja cobró con el premio descontado y el servidor NO lo aplicó, queda en la bitácora', async () => {
    // Pasa al reconectar: la caja cobró $70 sin red, y cuando la venta llega el premio
    // ya se usó en otra caja. La cuenta queda debiendo $30 — eso no puede pasar callado.
    ;(redeemStampReward as jest.Mock).mockRejectedValue(new Error('Este premio ya fue canjeado.'))

    const { applyStampRewardToNewOrder } = await import('@/services/mobile/order.mobile.service')
    await applyStampRewardToNewOrder('v1', 'o1', 'rw1', 'staff9', 3000)

    expect(activity.logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'STAMP_REWARD_NOT_AS_CHARGED',
        entity: 'Order',
        entityId: 'o1',
        venueId: 'v1',
        data: expect.objectContaining({ stampRewardId: 'rw1', expectedCents: 3000, confirmedCents: 0 }),
      }),
    )
  })

  it('si el servidor confirmó otro monto, también', async () => {
    ;(redeemStampReward as jest.Mock).mockResolvedValue({ discountAmount: 25, rewardLabel: 'Premio', order: {} })

    const { applyStampRewardToNewOrder } = await import('@/services/mobile/order.mobile.service')
    await applyStampRewardToNewOrder('v1', 'o1', 'rw1', 'staff9', 3000)

    expect(activity.logAction).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ expectedCents: 3000, confirmedCents: 2500 }) }),
    )
  })

  it('si salió exacto, o la caja no dijo qué esperaba, no hay nada que anotar', async () => {
    ;(redeemStampReward as jest.Mock).mockResolvedValue({ discountAmount: 30, rewardLabel: 'Premio', order: {} })

    const { applyStampRewardToNewOrder } = await import('@/services/mobile/order.mobile.service')
    await applyStampRewardToNewOrder('v1', 'o1', 'rw1', 'staff9', 3000)
    await applyStampRewardToNewOrder('v1', 'o1', 'rw1', 'staff9')

    expect(activity.logAction).not.toHaveBeenCalled()
  })
})
