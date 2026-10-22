/**
 * Codex b1 #1 y #5 (Rappi fase 2): el barrido de «pagadas pero abiertas» (`paid-order-reconciler` →
 * `shared/pagadaPeroAbierta.ts` → `reconcileOrderFromPayments`) y los pedidos de REPARTO.
 *
 * Un pedido de reparto nace PAGADO (la plataforma ya cobró) y ABIERTO (la cocina lo está preparando): para el barrido es
 * exactamente una «pagada pero abierta», así que a los ~5 min lo elegía y lo «reparaba» con la aritmética del cobro del TPV.
 *  · #1 Esa aritmética (`subtotal − descuento + cargo + propina`) no conoce el envío que la ingesta suma al total
 *    (`merchantFees`): la venta perdía el envío y el barrido denunciaba un sobrepago que no existe.
 *  · #5 Y la pasaba a COMPLETED con la comanda todavía en la cocina: el tablero le quitaba el botón «Cancelar» y
 *    `denyDeliveryOrder` dejaba de verlo como aceptado (con Rappi: rechazo → 400 → error genérico, sin las instrucciones
 *    de F2; con Uber: el protocolo de RECHAZO sobre un pedido ya aceptado).
 *
 * Ronda 1 (ruling del controlador, 22-oct): el barrido NUNCA recalcula el dinero de un pedido que liquida una plataforma y
 * NUNCA cierra uno sin aceptar. Tarea 22, decisión «B» del founder (22-oct): uno aceptado y pagado se cierra, sólo de estado,
 * cuando la cocina lo termina (ninguna comanda sigue en NEW/PREPARING) o al acabar el día del negocio EN SU ZONA, lo que pase
 * primero. El día del negocio es el de la CAJA (`businessDayStart`): empieza a las 04:00, no a medianoche (Ronda de arreglo 1). Mientras tanto sigue abierto y la cocina conserva «Cancelar».
 *
 * 🔴 El negocio de la prueba vive en Asia/Tokyo (UTC+9, sin horario de verano): lejos de la zona del servidor y de la sesión de
 * Postgres (America/Mexico_City en la Mac, UTC en Render). Los pedidos que dependen del reloj se FECHAN a una hora fija de
 * Tokio (`fechar`) y el barrido corre con un ahora fijo: ninguna prueba depende de la hora a la que se corre.
 *
 * Contra Postgres real: lo que elige al pedido es la consulta SQL del barrido, no un doble.
 */
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { DeliveryChannelLink, DeliveryProvider, OrderAcceptanceMode, OrderSource } from '@prisma/client'

import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import prisma from '@/utils/prismaClient'
import { utcTs } from '@/utils/sqlDates'
import { buildWatchdogSql } from '@/jobs/money-integrity-watchdog.job'
import { PaidOrderReconcilerJob } from '@/jobs/paid-order-reconciler.job'
import {
  cerrarPedidoDePlataformaSoloDeEstado,
  findPaidButOpenOrders,
  findPedidosDePlataformaPorCerrar,
} from '@/services/shared/pagadaPeroAbierta'
import { recallKdsOrder } from '@/services/mobile/kds.mobile.service'
import { ingestDeliveryOrder } from '@/services/delivery-channels/core/deliveryOrderIngestion.service'
import { denyDeliveryOrder } from '@/services/delivery-channels/core/respondToDeliveryOrder.service'
import type { NormalizedDeliveryOrder } from '@/services/delivery-channels/core/types'
import { normalizeRappiOrder } from '@/services/delivery-channels/providers/rappi/rappi.mapper'
import { CANCELAR_ACEPTADO_RAPPI, rappiAdapter } from '@/services/delivery-channels/providers/rappi/rappi.adapter'
import { uberAdapter } from '@/services/delivery-channels/providers/uber-eats/uber.adapter'
import { capacidadesDeComanda, ventasDeComandas } from '@/services/mobile/kdsCapacidades'

const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(database.hostname) || !/^\/avoqado_[a-z0-9]+_test_/.test(database.pathname)) {
  throw new Error('Esta suite exige una base de pruebas local y desechable, elegida explícitamente.')
}

const FIXTURE = path.join(__dirname, '../../unit/services/delivery-channels/fixtures/rappi/sandbox/new-order-marketplace-propina.json')
/** Pedido REAL del sandbox (M10): repartidor del negocio, pagado en línea. Productos 20 + envío 35 + propina 20 = 75. */
const marketplaceReal = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))

/** El mismo pedido real con otro folio (cada prueba registra el suyo). */
function pedidoRappi(): NormalizedDeliveryOrder {
  const raw = {
    ...marketplaceReal,
    order_detail: { ...marketplaceReal.order_detail, order_id: `${Date.now()}${Math.floor(Math.random() * 1000)}` },
  }
  // La hora del aviso es la del sandbox; se registra como pedido de AHORA para caer en la ventana del barrido.
  return { ...normalizeRappiOrder(raw), placedAt: new Date() }
}

/**
 * Uber con cargos del comercio y propina (la forma de `uberOrderIngestion.test.ts`): 608 + 30 de cargos, 20 de propina. Con
 * `cargosEnEfectivo`, los $30 los cobra el repartidor del negocio en efectivo: la plataforma liquida 608 y quedan 30 por cobrar.
 */
function pedidoUber(sku: string, { cargosEnEfectivo = false } = {}): NormalizedDeliveryOrder {
  return {
    externalId: `uber-${randomUUID()}`,
    displayId: 'AB12C',
    source: OrderSource.UBER_EATS,
    items: [{ externalId: sku, externalData: sku, name: 'Cochinita', quantity: 2, unitPrice: '304.00', total: '608.00' }],
    payment: {
      currency: 'MXN',
      saleAmount: '608.00',
      merchantFees: '30.00',
      tipAmount: '20.00',
      externallyPaidSale: cargosEnEfectivo ? '608.00' : '638.00',
      externallyPaidTip: '20.00',
      cashDueSale: cargosEnEfectivo ? '30.00' : '0.00',
      cashDueTip: '0.00',
    },
    raw: { fuente: 'test' },
    placedAt: new Date(),
  }
}

/** La zona del negocio de la prueba: ni la del servidor ni la de la sesión de Postgres. UTC+9 todo el año. */
const ZONA = 'Asia/Tokyo'
const HORA_MS = 3_600_000
const DIA_MS = 24 * HORA_MS
/** El día D (medianoche UTC de hace dos días): dentro de la ventana de 30 días del barrido, y fijo durante toda la suite. */
const D = (() => {
  const d = new Date(Date.now() - 2 * DIA_MS)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
})()
/** El instante real de las hh:mm EN TOKIO del día D (+ `dias`). Tokio = UTC+9: las 08:00 de Tokio son las 23:00 UTC de la víspera. */
const enTokio = (hh: number, mm = 0, dias = 0) => new Date(D + dias * DIA_MS + (hh - 9) * HORA_MS + mm * 60_000)

describe('el barrido de «pagadas pero abiertas» y los pedidos de reparto (Codex b1 #1 y #5, decisión B)', () => {
  let orgId: string, venueId: string, skuUber: string
  let linkRappi: DeliveryChannelLink, linkUber: DeliveryChannelLink

  /**
   * Una pasada REAL del barrido, por default como si hubieran pasado 6 minutos (la gracia es de 5). Sólo se acota a este negocio
   * y se apagan las pasadas de vales (no hay vales aquí): las consultas que eligen, el reparador y el cierre de estado son los de
   * producción.
   */
  const barrer = (ahora?: Date) =>
    new PaidOrderReconcilerJob({
      cron: { start: () => undefined, stop: () => undefined },
      now: () => ahora ?? new Date(Date.now() + 6 * 60_000),
      findCandidates: async opts => (await findPaidButOpenOrders(prisma, opts)).filter(c => c.venueId === venueId),
      findPedidosDePlataforma: async opts => (await findPedidosDePlataformaPorCerrar(prisma, opts)).filter(c => c.venueId === venueId),
      findSesionesAtoradas: async () => [],
      findSesionesDeVentasCerradas: async () => [],
    }).runNow()

  const avisoDeSobrepago = (orderId: string) =>
    (jest.mocked(logger.error).mock.calls as unknown[][]).filter(
      ([msg, meta]) => String(msg).includes('[Sobrepago]') && (meta as { orderId?: string } | undefined)?.orderId === orderId,
    )

  /** El pedido llegó (y se tocó por última vez) a esta hora: así el barrido corre con un ahora fijo sin depender del reloj. */
  const fechar = (orderId: string, instante: Date) =>
    prisma.$executeRaw`UPDATE "Order" SET "createdAt" = ${utcTs(instante)}, "updatedAt" = ${utcTs(instante)} WHERE id = ${orderId}`

  /** La cocina marca «listo» todas las comandas del pedido (la señal que el KDS de las apps escribe al terminar). */
  const terminarLaCocina = (orderId: string) => prisma.kdsOrder.updateMany({ where: { orderId }, data: { status: 'READY' } })

  const venta = (orderId: string) => prisma.order.findUniqueOrThrow({ where: { id: orderId } })
  const dinero = (o: Awaited<ReturnType<typeof venta>>) => ({
    total: o.total.toFixed(2),
    subtotal: o.subtotal.toFixed(2),
    descuento: o.discountAmount.toFixed(2),
    propina: o.tipAmount.toFixed(2),
    pagado: o.paidAmount.toFixed(2),
    porCobrar: o.remainingBalance.toFixed(2),
    cobro: o.paymentStatus,
  })

  /**
   * El asiento que deja la cuarta pasada al cerrar ESTE pedido: prueba que el barrido lo alcanzó por su id (no un falso verde).
   * `logAction` es un doble en la integración (`integration-setup.ts`): se leen sus llamadas.
   */
  const cierreAsentado = (orderId: string) =>
    jest
      .mocked(logAction)
      .mock.calls.map(([p]) => p)
      .filter(p => p.action === 'ORDER_RECONCILED_PAID' && p.entityId === orderId && p.venueId === venueId)

  /** Lo que el tablero de cocina le pinta a la comanda del pedido (la misma carga por lote del KDS). */
  async function capacidadesEnCocina(orderId: string) {
    const comanda = await prisma.kdsOrder.findFirstOrThrow({ where: { orderId }, include: { items: true } })
    const ventas = await ventasDeComandas(prisma as any, venueId, [comanda])
    return { comanda, capacidades: capacidadesDeComanda(comanda, ventas.get(orderId)!) }
  }

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: `Org barrido ${Date.now()}`, email: `b${Date.now()}@t.mx`, phone: '5555555555' },
    })
    orgId = org.id
    const v = await prisma.venue.create({
      data: { organizationId: orgId, name: `V barrido ${Date.now()}`, slug: `vb-${Date.now()}`, timezone: ZONA },
    })
    venueId = v.id
    const cat = await prisma.menuCategory.create({ data: { venueId, name: 'Cat', slug: `cb-${Date.now()}` } })
    // Los SKU que traen los pedidos: así la ingesta encuentra el producto y no crea uno «sin mapear».
    await prisma.product.create({ data: { venueId, categoryId: cat.id, name: 'Agua Mineral 1L', sku: 'BEBIDAS-002', price: '20.00' } })
    skuUber = `SKU-UBER-${Date.now()}`
    await prisma.product.create({ data: { venueId, categoryId: cat.id, name: 'Cochinita', sku: skuUber, price: '304.00' } })
    linkRappi = await prisma.deliveryChannelLink.create({
      data: { venueId, provider: DeliveryProvider.RAPPI, externalLocationId: `rappi-${Date.now()}`, webhookSecret: 'x' },
    })
    linkUber = await prisma.deliveryChannelLink.create({
      data: { venueId, provider: DeliveryProvider.UBER_EATS, externalLocationId: `uber-${Date.now()}`, webhookSecret: 'x' },
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
    jest.mocked(logger.error).mockClear()
  })

  afterAll(async () => {
    if (!venueId) return
    try {
      const orders = await prisma.order.findMany({ where: { venueId }, select: { id: true } })
      const ids = orders.map(o => o.id)
      await prisma.kdsOrder.deleteMany({ where: { venueId } })
      await prisma.activityLog.deleteMany({ where: { venueId } })
      await prisma.paymentAllocation.deleteMany({ where: { orderId: { in: ids } } })
      await prisma.inventoryPosting.deleteMany({ where: { venueId } })
      await prisma.payment.deleteMany({ where: { venueId } })
      await prisma.orderItemModifier.deleteMany({ where: { orderItem: { orderId: { in: ids } } } })
      await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } })
      await prisma.order.deleteMany({ where: { venueId } })
      await prisma.deliveryChannelLink.deleteMany({ where: { venueId } })
      await prisma.venueTenderTypeRevision.deleteMany({ where: { venueId } })
      await prisma.venueTenderType.deleteMany({ where: { venueId } })
      await prisma.product.deleteMany({ where: { venueId } })
      await prisma.menuCategory.deleteMany({ where: { venueId } })
      await prisma.venue.deleteMany({ where: { id: venueId } })
      await prisma.organization.deleteMany({ where: { id: orgId } })
    } catch {
      /* base desechable: se borra entera al terminar */
    }
  })

  it('conserva la aceptación original al reintentar y no cierra un pedido creado antes de las 4 pero aceptado después', async () => {
    const aceptado = enTokio(4, 1, 1)
    const pedido = Object.assign(pedidoRappi(), { placedAt: enTokio(3, 59, 1), providerAccepted: true, providerAcceptedAt: aceptado })
    const { order } = await ingestDeliveryOrder(pedido, { ...linkRappi, orderAcceptanceMode: OrderAcceptanceMode.AUTO })
    await fechar(order.id, pedido.placedAt)
    await ingestDeliveryOrder({ ...pedido, providerAcceptedAt: enTokio(4, 5, 2) } as typeof pedido, linkRappi)
    expect((await venta(order.id)).providerAcceptedAt).toEqual(aceptado)
    await fechar(order.id, pedido.placedAt) // el reintento real toca updatedAt; se vuelve a fijar el reloj de esta prueba
    await barrer(enTokio(4, 10, 1))
    expect((await venta(order.id)).status).toBe('CONFIRMED')
    await barrer(enTokio(4, 10, 2))
    const despues = await venta(order.id)
    expect(despues.status).toBe('COMPLETED')
    expect(dinero(despues)).toEqual(dinero(order))
  })

  it.each(['0.00', '10.00'])(
    'cierra una venta de plataforma cubierta totalmente por descuento, propina %s, sin cambiar dinero',
    async propina => {
      const pedido = pedidoRappi()
      pedido.items = [{ ...pedido.items[0], unitPrice: '100.00', total: '100.00', quantity: 1, modifiers: [] }]
      pedido.payment = {
        ...pedido.payment,
        saleAmount: '100.00',
        merchantFees: '0.00',
        discountAmount: '100.00',
        tipAmount: propina,
        externallyPaidSale: '0.00',
        externallyPaidTip: propina,
        cashDueSale: '0.00',
        cashDueTip: '0.00',
      }
      const { order } = await ingestDeliveryOrder(pedido, { ...linkRappi, orderAcceptanceMode: OrderAcceptanceMode.AUTO })
      expect(order.paymentStatus).toBe('PAID')
      expect(order.total.toFixed(2)).toBe('0.00')
      await fechar(order.id, enTokio(12))
      const avisos = async () =>
        (await prisma.$queryRawUnsafe<Array<{ check: string; order_id: string }>>(buildWatchdogSql(enTokio(12, 10)).details))
          .filter(f => f.check === 'PAGADA PERO ABIERTA')
          .map(f => f.order_id)
      expect(await avisos()).not.toContain(order.id)
      await terminarLaCocina(order.id)
      expect(await avisos()).toContain(order.id)
      await barrer(enTokio(12, 10))
      const despues = await venta(order.id)
      expect(despues.status).toBe('COMPLETED')
      expect(dinero(despues)).toEqual(dinero(order))
      expect(await avisos()).not.toContain(order.id)
    },
  )

  it('una cortesía propia sin pago sigue a cargo del cajero', async () => {
    const propia = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `cortesia-${Date.now()}`,
        subtotal: '100.00',
        discountAmount: '100.00',
        total: '0.00',
        taxAmount: '0.00',
        status: 'CONFIRMED',
        paymentStatus: 'PAID',
      },
    })
    await fechar(propia.id, enTokio(12))
    await barrer(enTokio(4, 10, 1))
    expect((await venta(propia.id)).status).toBe('CONFIRMED')
  })

  it('🔴 #1 Rappi con repartidor propio (pedido real 20 + 35 + 20): después del barrido la venta CONSERVA el envío y no hay sobrepago', async () => {
    const { order } = await ingestDeliveryOrder(pedidoRappi(), { ...linkRappi, orderAcceptanceMode: OrderAcceptanceMode.AUTO })
    // Lo que deja la ingesta (el dinero exacto de la Tarea 12): venta 20 + envío 35 = 55, propina 20 aparte.
    expect(order.total.toFixed(2)).toBe('55.00')
    // La cocina ya lo terminó: el barrido TIENE que alcanzarlo y cerrarlo. Si no lo alcanzara (p. ej. con más de 50 pagadas
    // abiertas más viejas delante), el dinero saldría intacto por no haberlo tocado: el estado y el asiento lo delatan.
    await fechar(order.id, enTokio(12))
    await terminarLaCocina(order.id)

    await barrer(enTokio(12, 6))

    const despues = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(despues.id).toBe(order.id)
    expect(despues.status).toBe('COMPLETED')
    expect(cierreAsentado(order.id)).toHaveLength(1)
    expect(despues.subtotal.toFixed(2)).toBe('20.00')
    expect(despues.total.toFixed(2)).toBe('55.00') // antes del arreglo: 40.00 (se fue el envío y entró la propina)
    expect(despues.tipAmount.toFixed(2)).toBe('20.00')
    expect(despues.paidAmount.toFixed(2)).toBe('75.00') // lo que liquida Rappi: 55 de venta + 20 de propina
    expect(despues.remainingBalance.toFixed(2)).toBe('0.00')
    expect(despues.paymentStatus).toBe('PAID')
    expect(avisoDeSobrepago(order.id)).toHaveLength(0) // antes: «🚨 [Sobrepago]» de $35 que no existe
  })

  // Decisión B: con la comanda en la cocina y el día del negocio en curso, el barrido NO lo cierra.
  it('🔴 #5 Rappi aceptado con la comanda en la cocina: después del barrido la cocina sigue viendo «Cancelar» y recibe cómo pedirlo a Rappi', async () => {
    const { order } = await ingestDeliveryOrder(pedidoRappi(), { ...linkRappi, orderAcceptanceMode: OrderAcceptanceMode.AUTO })
    await fechar(order.id, enTokio(12))

    await barrer(enTokio(12, 6))

    expect((await venta(order.id)).status).toBe('CONFIRMED') // antes: COMPLETED a los 5-15 min
    const { comanda, capacidades } = await capacidadesEnCocina(order.id)
    expect(comanda.status).toBe('NEW') // la comanda sigue en la cocina
    expect(capacidades.comanda.canCancelDelivery).toBe(true) // antes: false (VENTA_CERRADA)

    // Rappi contesta 400 a un rechazo sobre un pedido ya tomado (M11): si se llamara, ése sería el error genérico.
    const rechazo = jest
      .spyOn(rappiAdapter, 'denyOrder')
      .mockResolvedValue({ ok: false, status: 400, raw: '{"message":"Invalid transition from {TAKEN} to {REJECTED}"}' })
    const r = await denyDeliveryOrder(venueId, order.id, 'OUT_OF_ITEMS')

    expect(r).toEqual({ outcome: 'PROVEEDOR_NO_CANCELA', mensaje: CANCELAR_ACEPTADO_RAPPI.appDeAliados })
    expect(rechazo).not.toHaveBeenCalled()
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).not.toBe('CANCELLED')
  })

  it('🔴 #1 en el núcleo compartido: un pedido de Uber con cargos del comercio (608 + 30, propina 20) tampoco pierde los cargos', async () => {
    const { order } = await ingestDeliveryOrder(pedidoUber(skuUber), { ...linkUber, orderAcceptanceMode: OrderAcceptanceMode.AUTO })
    expect(order.total.toFixed(2)).toBe('638.00')
    // Igual que el de Rappi: terminado en la cocina, el barrido tiene que alcanzarlo (estado y asiento) sin tocar su dinero.
    await fechar(order.id, enTokio(12))
    await terminarLaCocina(order.id)

    await barrer(enTokio(12, 6))

    const despues = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(despues.id).toBe(order.id)
    expect(despues.status).toBe('COMPLETED')
    expect(cierreAsentado(order.id)).toHaveLength(1)
    expect(despues.total.toFixed(2)).toBe('638.00') // antes: 628.00
    expect(despues.tipAmount.toFixed(2)).toBe('20.00')
    expect(despues.paidAmount.toFixed(2)).toBe('658.00')
    expect(despues.remainingBalance.toFixed(2)).toBe('0.00')
    expect(avisoDeSobrepago(order.id)).toHaveLength(0) // antes: sobrepago falso de $30
  })

  // Decisión B: ver el caso de Rappi de arriba.
  it('🔴 #5 en el núcleo compartido: un Uber aceptado y en la cocina conserva «Cancelar» y se CANCELA (no se rechaza) después del barrido', async () => {
    const { order } = await ingestDeliveryOrder(pedidoUber(skuUber), { ...linkUber, orderAcceptanceMode: OrderAcceptanceMode.AUTO })
    await fechar(order.id, enTokio(12))

    await barrer(enTokio(12, 6))

    expect((await venta(order.id)).status).toBe('CONFIRMED')
    expect((await capacidadesEnCocina(order.id)).capacidades.comanda.canCancelDelivery).toBe(true)
    const rechazo = jest.spyOn(uberAdapter, 'denyOrder').mockResolvedValue({ ok: true, status: 200, raw: '' })
    const cancelacion = jest.spyOn(uberAdapter, 'cancelOrder').mockResolvedValue({ ok: true, status: 200, raw: '' })

    const r = await denyDeliveryOrder(venueId, order.id, 'OUT_OF_ITEMS')

    expect(r.outcome).toBe('CANCELLED')
    expect(cancelacion).toHaveBeenCalled() // ya aceptado ⇒ el protocolo de cancelar
    expect(rechazo).not.toHaveBeenCalled() // antes: el de rechazar, como si nunca se hubiera aceptado
  })

  it('🔴 Codex b2: Deshacer entre selección y cierre conserva abierta la venta y no cambia el dinero', async () => {
    const { order } = await ingestDeliveryOrder(pedidoRappi(), { ...linkRappi, orderAcceptanceMode: OrderAcceptanceMode.AUTO })
    await fechar(order.id, enTokio(12))
    await prisma.kdsOrder.updateMany({ where: { orderId: order.id }, data: { status: 'COMPLETED' } })
    const ahora = enTokio(12, 16)
    const candidata = (await findPedidosDePlataformaPorCerrar(prisma, { graceMs: 300_000, limit: 50, now: ahora })).find(
      p => p.id === order.id,
    )
    expect(candidata).toBeDefined()
    const comanda = await prisma.kdsOrder.findFirstOrThrow({ where: { orderId: order.id, venueId } })
    await recallKdsOrder(venueId, comanda.id)

    expect(await cerrarPedidoDePlataformaSoloDeEstado(prisma, candidata!, ahora)).toBe(false)
    const abierta = await venta(order.id)
    expect(abierta.status).toBe('CONFIRMED')
    expect(dinero(abierta)).toEqual(dinero(order))

    // El mismo escritor vuelve a funcionar cuando cocina realmente termina.
    await terminarLaCocina(order.id)
    expect(await cerrarPedidoDePlataformaSoloDeEstado(prisma, candidata!, ahora)).toBe(true)
    expect((await venta(order.id)).status).toBe('COMPLETED')
    expect(dinero(await venta(order.id))).toEqual(dinero(order))
  })

  it('decisión B: la cocina lo termina ⇒ la siguiente pasada del barrido lo cierra, SÓLO de estado', async () => {
    const { order } = await ingestDeliveryOrder(pedidoRappi(), { ...linkRappi, orderAcceptanceMode: OrderAcceptanceMode.AUTO })
    expect(order.status).toBe('CONFIRMED')
    await fechar(order.id, enTokio(12))

    // Mientras la cocina lo prepara, sigue abierto.
    await barrer(enTokio(12, 6))
    expect((await venta(order.id)).status).toBe('CONFIRMED')

    await terminarLaCocina(order.id)
    await barrer(enTokio(12, 16))

    const despues = await venta(order.id)
    // Lo que cambia: el estado.
    expect(despues.status).toBe('COMPLETED')
    expect(despues.completedAt).not.toBeNull()
    expect(cierreAsentado(order.id)).toHaveLength(1)
    // Lo que no: ni un centavo, ni el estado de cobro.
    expect(dinero(despues)).toEqual(dinero(order))
  })

  it('🔴 decisión B: sin comanda, uno aceptado a las 23:50 sigue abierto a las 00:30 y a las 03:59, y se cierra a las 04:00 (el día de la CAJA)', async () => {
    const { order } = await ingestDeliveryOrder(pedidoRappi(), { ...linkRappi, orderAcceptanceMode: OrderAcceptanceMode.AUTO })
    await prisma.kdsOrder.deleteMany({ where: { orderId: order.id } }) // negocio sin cocina: sólo lo cierra el fin del día
    await fechar(order.id, enTokio(23, 50))

    // Pasada la medianoche el día del negocio sigue: un bar que cierra a las 2 am conserva «Cancelar».
    await barrer(enTokio(0, 30, 1))
    expect((await venta(order.id)).status).toBe('CONFIRMED')
    await barrer(enTokio(3, 59, 1))
    expect((await venta(order.id)).status).toBe('CONFIRMED')

    // A las 04:00 del negocio empieza otro día (el corte de la caja, `businessDayStart`): se cierra, sólo de estado.
    await barrer(enTokio(4, 0, 1))
    const despues = await venta(order.id)
    expect(despues.status).toBe('COMPLETED')
    expect(dinero(despues)).toEqual(dinero(order))
  })

  it('🔴 decisión B: uno aceptado a las 02:00 es del día del negocio de la víspera: se cierra a las 04:00 de ESE día, no del siguiente', async () => {
    const { order } = await ingestDeliveryOrder(pedidoRappi(), { ...linkRappi, orderAcceptanceMode: OrderAcceptanceMode.AUTO })
    await prisma.kdsOrder.deleteMany({ where: { orderId: order.id } })
    await fechar(order.id, enTokio(2, 0, 1))

    await barrer(enTokio(3, 59, 1))
    expect((await venta(order.id)).status).toBe('CONFIRMED')

    // Se cierra a las 04:00 de ese mismo día, no a las 04:00 del siguiente.
    await barrer(enTokio(4, 0, 1))
    expect((await venta(order.id)).status).toBe('COMPLETED')
  })

  it('🔴 decisión B: se acabó el día del negocio con la comanda aún abierta ⇒ se cierra; manda la zona del NEGOCIO, no la del servidor', async () => {
    const { order } = await ingestDeliveryOrder(pedidoUber(skuUber), { ...linkUber, orderAcceptanceMode: OrderAcceptanceMode.AUTO })
    // 08:00 de Tokio del día D = 23:00 UTC y 17:00 de CDMX de la VÍSPERA.
    await fechar(order.id, enTokio(8))

    // 23:30 de Tokio del día D = 14:30 UTC y 08:30 de CDMX del día D: en UTC y en CDMX ya cambió el día, en Tokio no.
    await barrer(enTokio(23, 30))
    expect((await venta(order.id)).status).toBe('CONFIRMED')

    // 00:10 de Tokio: todavía es el día del negocio que empezó a las 04:00 del día D.
    await barrer(enTokio(0, 10, 1))
    expect((await venta(order.id)).status).toBe('CONFIRMED')

    await barrer(enTokio(4, 10, 1))
    const despues = await venta(order.id)
    expect(despues.status).toBe('COMPLETED')
    expect(dinero(despues)).toEqual(dinero(order))
    // El barrido cierra la VENTA; la comanda es de la cocina y no se toca.
    expect((await prisma.kdsOrder.findFirstOrThrow({ where: { orderId: order.id } })).status).toBe('NEW')
  })

  it('decisión B: un pedido programado no se cierra por el fin de un día anterior al suyo', async () => {
    const { order } = await ingestDeliveryOrder(pedidoRappi(), { ...linkRappi, orderAcceptanceMode: OrderAcceptanceMode.AUTO })
    await prisma.kdsOrder.deleteMany({ where: { orderId: order.id } }) // un programado no tiene comanda hasta su hora
    await fechar(order.id, enTokio(20))
    await prisma.$executeRaw`UPDATE "Order" SET "scheduledFor" = ${utcTs(enTokio(13, 0, 1))} WHERE id = ${order.id}`

    await barrer(enTokio(4, 10, 1)) // acabó el día en que llegó, no el suyo
    expect((await venta(order.id)).status).toBe('CONFIRMED')

    await barrer(enTokio(4, 10, 2))
    expect((await venta(order.id)).status).toBe('COMPLETED')
  })

  it('🔴 la invariante 6 del vigilante NO grita por un pedido que B todavía deja abierto, y SÍ por lo que siempre gritó', async () => {
    const { order } = await ingestDeliveryOrder(pedidoRappi(), { ...linkRappi, orderAcceptanceMode: OrderAcceptanceMode.AUTO })
    await fechar(order.id, enTokio(12))
    // Una cuenta propia cobrada que se quedó abierta: lo de siempre.
    const propia = await prisma.order.create({
      data: {
        venueId,
        orderNumber: randomUUID(),
        status: 'CONFIRMED',
        subtotal: 90,
        taxAmount: 0,
        total: 90,
        remainingBalance: 90,
        items: { create: { productName: 'Plato', quantity: 1, unitPrice: 90, taxAmount: 0, total: 90 } },
        payments: {
          create: { venueId, amount: 90, feePercentage: 0, feeAmount: 0, netAmount: 90, method: 'CASH', status: 'COMPLETED' },
        },
      },
    })
    await fechar(propia.id, enTokio(12))

    const gritos = async (ahora: Date) => {
      const filas = await prisma.$queryRawUnsafe<Array<{ check: string; order_id: string }>>(buildWatchdogSql(ahora).details)
      return filas.filter(f => f.check === 'PAGADA PERO ABIERTA').map(f => f.order_id)
    }

    // Mismo día y la comanda en la cocina: B lo deja abierto a propósito.
    const deDia = await gritos(enTokio(12, 30))
    expect(deDia).not.toContain(order.id)
    expect(deDia).toContain(propia.id)

    // Se acabó su día y sigue abierto (el barrido no pasó): eso SÍ es lo que el vigilante vigila.
    const alOtroDia = await gritos(enTokio(4, 10, 1))
    expect(alOtroDia).toContain(order.id)
    expect(alOtroDia).toContain(propia.id)

    // Y si la cocina ya lo terminó, también: ya tocaba cerrarlo.
    await terminarLaCocina(order.id)
    expect(await gritos(enTokio(12, 30))).toContain(order.id)
  })

  it('🔴 un pedido que todavía espera a la cocina (Uber MANUAL, sin aceptar) NO se cierra; en cuanto se acepta, sí, sólo de estado', async () => {
    const { order } = await ingestDeliveryOrder(pedidoUber(skuUber), { ...linkUber, orderAcceptanceMode: OrderAcceptanceMode.MANUAL })
    expect(order.status).toBe('PENDING')
    await fechar(order.id, enTokio(12))
    // Aun con la cocina terminada: sin aceptar no se cierra nunca.
    await terminarLaCocina(order.id)

    await barrer(enTokio(12, 6))

    // Antes del arreglo: COMPLETED a los 5-15 min, el tablero dejaba de pedir «aceptar» y Uber lo cancelaba solo (~11.5 min).
    const sinAceptar = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(sinAceptar.status).toBe('PENDING')
    expect(sinAceptar.total.toFixed(2)).toBe('638.00')

    // La cocina lo acepta (la marca que deja `acceptDeliveryOrder` con el 2xx de Uber), a las 12:02 de Tokio.
    await prisma.$executeRaw`UPDATE "Order" SET "providerAcceptedAt" = ${utcTs(enTokio(12, 2))}, "providerAcceptedEvidence" = 'HTTP_2XX',
      "updatedAt" = ${utcTs(enTokio(12, 2))} WHERE id = ${order.id}`
    await barrer(enTokio(12, 10))

    const aceptado = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(aceptado.status).toBe('COMPLETED')
    expect(aceptado.total.toFixed(2)).toBe('638.00')
    expect(aceptado.tipAmount.toFixed(2)).toBe('20.00')
    expect(avisoDeSobrepago(order.id)).toHaveLength(0)
  })

  it('🔴 con efectivo por cobrar el barrido no lo da por pagado ni lo cierra: no decide el dinero de una plataforma', async () => {
    const { order } = await ingestDeliveryOrder(pedidoUber(skuUber, { cargosEnEfectivo: true }), {
      ...linkUber,
      orderAcceptanceMode: OrderAcceptanceMode.AUTO,
    })
    expect(order.paymentStatus).toBe('PARTIAL')

    await barrer()

    // Antes del arreglo: lo «reparaba» con la aritmética del cobro (que no ve los $30 de cargos) y lo cerraba PAGADO.
    const despues = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(despues.status).toBe('CONFIRMED')
    expect(despues.paymentStatus).toBe('PARTIAL')
    expect(despues.remainingBalance.toFixed(2)).toBe('30.00')
    expect(despues.total.toFixed(2)).toBe('638.00')
  })

  it('mostrador sin cambios: una cuenta propia cobrada que quedó abierta la sigue cerrando el barrido', async () => {
    const o = await prisma.order.create({
      data: {
        venueId,
        orderNumber: randomUUID(),
        status: 'CONFIRMED',
        subtotal: 150,
        taxAmount: 0,
        total: 150,
        remainingBalance: 150,
        items: { create: { productName: 'Plato', quantity: 1, unitPrice: 150, taxAmount: 0, total: 150 } },
        payments: {
          create: { venueId, amount: 150, feePercentage: 0, feeAmount: 0, netAmount: 150, method: 'CASH', status: 'COMPLETED' },
        },
      },
    })

    await barrer()

    const despues = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(despues.status).toBe('COMPLETED')
    expect(despues.paymentStatus).toBe('PAID')
    expect(despues.total.toFixed(2)).toBe('150.00')
  })
})
