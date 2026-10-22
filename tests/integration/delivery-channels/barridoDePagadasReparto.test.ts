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
 * Ronda 1, sin decisión de producto (ruling del controlador, 22-oct): el barrido NUNCA recalcula el dinero de un pedido que
 * liquida una plataforma y NUNCA cierra uno sin aceptar. CUÁNDO cierra uno aceptado (#5) lo decide el founder (A/B/C): mientras
 * tanto se conserva lo de hoy —lo cierra al pasar la gracia, sólo de estado— y los casos del #5 esperan con `it.skip`.
 *
 * Contra Postgres real: lo que elige al pedido es la consulta SQL del barrido, no un doble.
 */
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { DeliveryChannelLink, DeliveryProvider, OrderAcceptanceMode, OrderSource } from '@prisma/client'

import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { PaidOrderReconcilerJob } from '@/jobs/paid-order-reconciler.job'
import { findPaidButOpenOrders, findPedidosDePlataformaPorCerrar } from '@/services/shared/pagadaPeroAbierta'
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

describe('el barrido de «pagadas pero abiertas» y los pedidos de reparto (Codex b1 #1 y #5)', () => {
  let orgId: string, venueId: string, skuUber: string
  let linkRappi: DeliveryChannelLink, linkUber: DeliveryChannelLink

  /**
   * Una pasada REAL del barrido, como si hubieran pasado 6 minutos (la gracia es de 5). Sólo se acota a este negocio y se
   * apagan las pasadas de vales (no hay vales aquí): las consultas que eligen, el reparador y el cierre de estado son los de
   * producción.
   */
  const barrer = () =>
    new PaidOrderReconcilerJob({
      cron: { start: () => undefined, stop: () => undefined },
      now: () => new Date(Date.now() + 6 * 60_000),
      findCandidates: async opts => (await findPaidButOpenOrders(prisma, opts)).filter(c => c.venueId === venueId),
      findPedidosDePlataforma: async opts => (await findPedidosDePlataformaPorCerrar(prisma, opts)).filter(c => c.venueId === venueId),
      findSesionesAtoradas: async () => [],
      findSesionesDeVentasCerradas: async () => [],
    }).runNow()

  const avisoDeSobrepago = (orderId: string) =>
    (jest.mocked(logger.error).mock.calls as unknown[][]).filter(
      ([msg, meta]) => String(msg).includes('[Sobrepago]') && (meta as { orderId?: string } | undefined)?.orderId === orderId,
    )

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
    const v = await prisma.venue.create({ data: { organizationId: orgId, name: `V barrido ${Date.now()}`, slug: `vb-${Date.now()}` } })
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

  it('🔴 #1 Rappi con repartidor propio (pedido real 20 + 35 + 20): después del barrido la venta CONSERVA el envío y no hay sobrepago', async () => {
    const { order } = await ingestDeliveryOrder(pedidoRappi(), { ...linkRappi, orderAcceptanceMode: OrderAcceptanceMode.AUTO })
    // Lo que deja la ingesta (el dinero exacto de la Tarea 12): venta 20 + envío 35 = 55, propina 20 aparte.
    expect(order.total.toFixed(2)).toBe('55.00')

    await barrer()

    const despues = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(despues.subtotal.toFixed(2)).toBe('20.00')
    expect(despues.total.toFixed(2)).toBe('55.00') // antes del arreglo: 40.00 (se fue el envío y entró la propina)
    expect(despues.tipAmount.toFixed(2)).toBe('20.00')
    expect(despues.paidAmount.toFixed(2)).toBe('75.00') // lo que liquida Rappi: 55 de venta + 20 de propina
    expect(despues.remainingBalance.toFixed(2)).toBe('0.00')
    expect(despues.paymentStatus).toBe('PAID')
    expect(avisoDeSobrepago(order.id)).toHaveLength(0) // antes: «🚨 [Sobrepago]» de $35 que no existe
  })

  // ⏸ Espera la decisión del founder (A/B/C, Codex b1 #5): CUÁNDO se cierra un pedido de plataforma aceptado. Con A o B este caso
  // pasa sin tocarlo; con C cambian el tablero y `denyDeliveryOrder`. Hoy el barrido lo sigue cerrando al pasar la gracia.
  it.skip('🔴 #5 Rappi aceptado con la comanda en la cocina: después del barrido la cocina sigue viendo «Cancelar» y recibe cómo pedirlo a Rappi', async () => {
    const { order } = await ingestDeliveryOrder(pedidoRappi(), { ...linkRappi, orderAcceptanceMode: OrderAcceptanceMode.AUTO })

    await barrer()

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

    await barrer()

    const despues = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(despues.total.toFixed(2)).toBe('638.00') // antes: 628.00
    expect(despues.tipAmount.toFixed(2)).toBe('20.00')
    expect(despues.paidAmount.toFixed(2)).toBe('658.00')
    expect(despues.remainingBalance.toFixed(2)).toBe('0.00')
    expect(avisoDeSobrepago(order.id)).toHaveLength(0) // antes: sobrepago falso de $30
  })

  // ⏸ Espera la decisión del founder (A/B/C, Codex b1 #5): ver el caso de Rappi de arriba.
  it.skip('🔴 #5 en el núcleo compartido: un Uber aceptado y en la cocina conserva «Cancelar» y se CANCELA (no se rechaza) después del barrido', async () => {
    const { order } = await ingestDeliveryOrder(pedidoUber(skuUber), { ...linkUber, orderAcceptanceMode: OrderAcceptanceMode.AUTO })

    await barrer()

    expect((await capacidadesEnCocina(order.id)).capacidades.comanda.canCancelDelivery).toBe(true)
    const rechazo = jest.spyOn(uberAdapter, 'denyOrder').mockResolvedValue({ ok: true, status: 200, raw: '' })
    const cancelacion = jest.spyOn(uberAdapter, 'cancelOrder').mockResolvedValue({ ok: true, status: 200, raw: '' })

    const r = await denyDeliveryOrder(venueId, order.id, 'OUT_OF_ITEMS')

    expect(r.outcome).toBe('CANCELLED')
    expect(cancelacion).toHaveBeenCalled() // ya aceptado ⇒ el protocolo de cancelar
    expect(rechazo).not.toHaveBeenCalled() // antes: el de rechazar, como si nunca se hubiera aceptado
  })

  it('HOY, hasta la decisión A/B/C: un pedido de plataforma aceptado y pagado se cierra al pasar la gracia, SÓLO de estado', async () => {
    const { order } = await ingestDeliveryOrder(pedidoRappi(), { ...linkRappi, orderAcceptanceMode: OrderAcceptanceMode.AUTO })
    expect(order.status).toBe('CONFIRMED')

    await barrer()

    const despues = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    // Lo que cambia: el estado (lo mismo que hacía el barrido desde el 2-sep; el CUÁNDO lo decide el founder).
    expect(despues.status).toBe('COMPLETED')
    expect(despues.completedAt).not.toBeNull()
    // Lo que no: ni un centavo, ni el estado de cobro.
    expect({
      total: despues.total.toFixed(2),
      subtotal: despues.subtotal.toFixed(2),
      descuento: despues.discountAmount.toFixed(2),
      propina: despues.tipAmount.toFixed(2),
      pagado: despues.paidAmount.toFixed(2),
      porCobrar: despues.remainingBalance.toFixed(2),
      cobro: despues.paymentStatus,
    }).toEqual({
      total: order.total.toFixed(2),
      subtotal: order.subtotal.toFixed(2),
      descuento: order.discountAmount.toFixed(2),
      propina: order.tipAmount.toFixed(2),
      pagado: order.paidAmount.toFixed(2),
      porCobrar: order.remainingBalance.toFixed(2),
      cobro: order.paymentStatus,
    })
  })

  it('🔴 un pedido que todavía espera a la cocina (Uber MANUAL, sin aceptar) NO se cierra; en cuanto se acepta, sí, sólo de estado', async () => {
    const { order } = await ingestDeliveryOrder(pedidoUber(skuUber), { ...linkUber, orderAcceptanceMode: OrderAcceptanceMode.MANUAL })
    expect(order.status).toBe('PENDING')

    await barrer()

    // Antes del arreglo: COMPLETED a los 5-15 min, el tablero dejaba de pedir «aceptar» y Uber lo cancelaba solo (~11.5 min).
    const sinAceptar = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(sinAceptar.status).toBe('PENDING')
    expect(sinAceptar.total.toFixed(2)).toBe('638.00')

    // La cocina lo acepta (la marca que deja `acceptDeliveryOrder` con el 2xx de Uber).
    await prisma.order.update({
      where: { id: order.id },
      data: { providerAcceptedAt: new Date(), providerAcceptedEvidence: 'HTTP_2XX' },
    })
    await barrer()

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
