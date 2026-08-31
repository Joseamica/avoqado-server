import {
  DeliveryChannelLink,
  DeliveryProvider,
  OrderSource,
  OriginSystem,
  PaymentMethod,
  PaymentFundsFlow,
  TransactionStatus,
} from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ingestDeliveryOrder } from '@/services/delivery-channels/core/deliveryOrderIngestion.service'
import { UBER_EXTERNAL_ID_PREFIX } from '@/services/delivery-channels/providers/uber-eats/uber.productResolver'
import type { NormalizedDeliveryOrder } from '@/services/delivery-channels/core/types'
import { runIngestionContract } from './ingestionContract'

// El evento se vuelve VENTA — Order + líneas + Payment + inventario, todo en UNA
// transacción. Contra PostgreSQL real: el unique de externalId y la idempotencia no se
// prueban con Prisma mockeado.
//
// Estos 7 casos nacieron contra `ingestUberOrder`, la ingesta duplicada que Uber tenía
// porque el núcleo contaba la propina dos veces. Con el núcleo ya arreglado, corren
// contra `ingestDeliveryOrder` y siguen siendo el mismo contrato: son la red que prueba
// que la unificación no perdió nada.
describe('ingesta de pedido Uber → Order + Payment (durable)', () => {
  let venueId: string, orgId: string, productId: string
  let link: DeliveryChannelLink

  const pedido = (externalId: string, itemExternalId = 'Cochinita_de_Doña_Si'): NormalizedDeliveryOrder => ({
    externalId,
    displayId: 'AB12C',
    source: OrderSource.UBER_EATS,
    items: [
      {
        externalId: itemExternalId,
        externalData: itemExternalId,
        name: 'Cochinita',
        quantity: 2,
        unitPrice: '304.00',
        total: '608.00',
        notes: 'Sin cebolla, por favor',
        modifiers: [{ externalId: 'Leche_entera', name: 'Leche entera', quantity: 1, price: '10.00' }],
      },
    ],
    payment: {
      currency: 'MXN',
      saleAmount: '608.00',
      merchantFees: '30.00',
      tipAmount: '20.00',
      externallyPaidSale: '638.00',
      externallyPaidTip: '20.00',
      cashDueSale: '0.00',
      cashDueTip: '0.00',
    },
    raw: { fuente: 'test' },
    placedAt: new Date('2026-08-20T20:05:55.000Z'),
  })

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: `Org ing ${Date.now()}`, email: `i${Date.now()}@t.mx`, phone: '5555555555' },
    })
    orgId = org.id
    const v = await prisma.venue.create({ data: { organizationId: orgId, name: `V ing ${Date.now()}`, slug: `vi-${Date.now()}` } })
    venueId = v.id
    const cat = await prisma.menuCategory.create({ data: { venueId, name: 'Cat', slug: `ci-${Date.now()}` } })
    const p = await prisma.product.create({
      data: {
        venueId,
        categoryId: cat.id,
        name: 'Cochinita',
        sku: `SKU-${Date.now()}`,
        externalId: `${UBER_EXTERNAL_ID_PREFIX}Cochinita_de_Doña_Si`,
        price: '304.00',
      },
    })
    productId = p.id
    link = await prisma.deliveryChannelLink.create({
      data: { venueId, provider: DeliveryProvider.UBER_EATS, externalLocationId: `store-${Date.now()}`, webhookSecret: 'x' },
    })
  })

  afterAll(async () => {
    try {
      const orders = await prisma.order.findMany({ where: { venueId }, select: { id: true } })
      const ids = orders.map(o => o.id)
      await prisma.paymentAllocation.deleteMany({
        where: { paymentId: { in: (await prisma.payment.findMany({ where: { venueId }, select: { id: true } })).map(p => p.id) } },
      })
      await prisma.payment.deleteMany({ where: { venueId } })
      await prisma.orderItemModifier.deleteMany({ where: { orderItem: { orderId: { in: ids } } } })
      await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } })
      await prisma.order.deleteMany({ where: { venueId } })
      // KdsOrder tiene FK a Venue: si no se borra, el deleteMany de venue de abajo
      // truena y el catch de este bloque se lo traga — venues de prueba acumulándose
      // en silencio para siempre. (KdsOrderItem cae solo, va en cascade.)
      await prisma.kdsOrder.deleteMany({ where: { venueId } })
      await prisma.deliveryChannelLink.deleteMany({ where: { venueId } })
      await prisma.venueTenderTypeRevision.deleteMany({ where: { venueId } })
      await prisma.venueTenderType.deleteMany({ where: { venueId } })
      await prisma.product.deleteMany({ where: { venueId } })
      await prisma.menuCategory.deleteMany({ where: { venueId } })
      await prisma.shift.deleteMany({ where: { venueId } })
      await prisma.venue.deleteMany({ where: { id: venueId } })
      await prisma.organization.deleteMany({ where: { id: orgId } })
    } catch {
      /* fixtures */
    }
  })

  it('crea la Order con el namespace del proveedor y sin mesero ni turno', async () => {
    const { order } = await ingestDeliveryOrder(pedido('ord-1'), link)
    expect(order.externalId).toBe('UBER_EATS:ord-1') // namespaceado: dos proveedores pueden repetir folio
    expect(order.source).toBe(OrderSource.UBER_EATS)
    expect(order.originSystem).toBe(OriginSystem.DELIVERY_PLATFORM)
    expect(order.servedById).toBeNull() // no hay mesero
    expect(order.shiftId).toBeNull() // no pertenece a un turno
    // 🔴 638, NO 658: el total es venta + cargos, SIN propina. Antes de arreglar el núcleo
    // la propina entraba también aquí y se contaba dos veces.
    expect(order.total.toString()).toBe('638')
    expect(order.subtotal.toString()).toBe('608')
  })

  it('resuelve el producto y guarda snapshot + modificadores', async () => {
    const { order } = await ingestDeliveryOrder(pedido('ord-2'), link)
    const items = await prisma.orderItem.findMany({ where: { orderId: order.id }, include: { modifiers: true } })
    expect(items).toHaveLength(1)
    expect(items[0].productId).toBe(productId)
    expect(items[0].productName).toBe('Cochinita') // snapshot, sobrevive si el producto cambia
    expect(items[0].quantity).toBe(2)
    expect(items[0].originSystem).toBe(OriginSystem.DELIVERY_PLATFORM)
    expect(items[0].modifiers).toHaveLength(1)
    expect(items[0].modifiers[0].name).toBe('Leche entera')
  })

  it('🔴 la instrucción del cliente llega a la LÍNEA — es lo que la cocina lee', async () => {
    // Defecto real encontrado con el pedido D8180 del sandbox de Uber (27-ago): el mapper
    // extraía `customer_request.special_instructions` correctamente y la ingesta NO la
    // escribía. La comanda salía sin la nota y se preparaba el platillo equivocado. Ningún
    // test lo vio porque todos verificaban al mapper, que estaba bien.
    const { order } = await ingestDeliveryOrder(pedido('ord-nota'), link)
    const items = await prisma.orderItem.findMany({ where: { orderId: order.id } })
    expect(items[0].notes).toBe('Sin cebolla, por favor')
  })

  it('la comanda de cocina guarda los modificadores en la MISMA forma que el POS', async () => {
    // 🔴 Este caso existe porque el de arriba pasaba mientras la cocina estaba rota: afirmaba
    // sobre `OrderItem` —la tabla de la VENTA— y la pantalla de cocina lee `KdsOrderItem`, que
    // es otra. La ingesta guardaba ahí `[{"name":…,"quantity":…}]` mientras el POS guardaba
    // `["texto"]` en esa misma columna, y la diferencia llegó hasta el fierro: en una Sunmi D3
    // con un pedido real de Uber, Android pintó el JSON crudo y iOS perdió el modificador.
    //
    // Cuando dos productores escriben al mismo almacén, el contrato no es el esquema: es la
    // FORMA del valor. Por eso se afirma el string EXACTO que queda guardado.
    const { order } = await ingestDeliveryOrder(pedido('ord-kds'), link)
    const kds = await prisma.kdsOrder.findFirst({ where: { orderId: order.id }, include: { items: true } })

    expect(kds).not.toBeNull()
    expect(kds!.orderType).toBe('DELIVERY')
    expect(kds!.items).toHaveLength(1)
    expect(kds!.items[0].modifiers).toBe('["Leche entera"]')
    expect(JSON.parse(kds!.items[0].modifiers!)).toEqual(['Leche entera'])
  })

  it('crea el Payment con tender del canal y fundsFlow EXTERNAL_RECORDED', async () => {
    const { order } = await ingestDeliveryOrder(pedido('ord-3'), link)
    const p = await prisma.payment.findFirst({ where: { orderId: order.id } })
    expect(p).not.toBeNull()
    expect(p!.amount.toString()).toBe('638') // venta + cargos, SIN propina
    expect(p!.tipAmount.toString()).toBe('20') // propina aparte: no se cuenta dos veces
    expect(p!.method).toBe(PaymentMethod.OTHER)
    expect(p!.fundsFlow).toBe(PaymentFundsFlow.EXTERNAL_RECORDED) // Avoqado NO deposita este dinero
    expect(p!.status).toBe(TransactionStatus.COMPLETED)
    expect(p!.tenderTypeId).not.toBeNull() // el tender se autoprovisionó
  })

  it('deja la cuenta cuadrada: paidAmount y remainingBalance coherentes', async () => {
    const { order } = await ingestDeliveryOrder(pedido('ord-4'), link)
    const o = await prisma.order.findUnique({ where: { id: order.id } })
    expect(o!.paidAmount.toString()).toBe('658') // 638 de venta + 20 de propina = lo que entró
    expect(o!.remainingBalance.toString()).toBe('0')
    expect(o!.paymentStatus).toBe('PAID')
  })

  it('IDEMPOTENTE: reingerir el mismo pedido no duplica Order ni Payment', async () => {
    const a = await ingestDeliveryOrder(pedido('ord-5'), link)
    const b = await ingestDeliveryOrder(pedido('ord-5'), link)
    expect(b.order.id).toBe(a.order.id)
    expect(b.created).toBe(false)
    expect(await prisma.payment.count({ where: { orderId: a.order.id } })).toBe(1)
  })

  it('🔴 si la comanda se perdió, el reintento la REPONE — un pedido pagado no se queda sin cocina', async () => {
    // Hallazgo de Codex (27-ago). Los webhooks son at-least-once y la comanda se crea FUERA
    // de la transacción que guarda la venta: si el proceso muere en medio, el reintento veía
    // `created=false` y se saltaba la comanda para siempre. Nadie se enteraba — no hay error,
    // sólo un pedido cobrado que la cocina nunca ve. Se simula borrando la comanda.
    const a = await ingestDeliveryOrder(pedido('ord-kds-perdida'), link)
    expect(await prisma.kdsOrder.count({ where: { orderId: a.order.id } })).toBe(1)

    await prisma.kdsOrder.deleteMany({ where: { orderId: a.order.id } })

    const b = await ingestDeliveryOrder(pedido('ord-kds-perdida'), link)
    expect(b.order.id).toBe(a.order.id) // sigue siendo la MISMA venta: no se duplica
    expect(b.created).toBe(false)
    expect(b.kitchenTicketCreated).toBe(true) // …pero la comanda vuelve
    expect(await prisma.kdsOrder.count({ where: { orderId: a.order.id } })).toBe(1)

    // 🔴 …y vuelve CON RUTEO. Sin releer los renglones existentes, la comanda repuesta
    // salía sin productId/categoryId y todo caía al ticket "SIN ESTACIÓN" (Codex, 2ª pasada).
    const repuesta = await prisma.kdsOrder.findFirstOrThrow({ where: { orderId: a.order.id }, include: { items: true } })
    expect(repuesta.items.length).toBeGreaterThan(0)
    expect(repuesta.items.every(i => i.productId !== null)).toBe(true)

    // 🔴 …y el ruteo apunta al renglón CORRECTO, no sólo a "alguno". Se aparea por el índice
    // del externalId porque `createdAt` no es estable dentro de una misma transacción: si se
    // desordenara, los tacos saldrían en la impresora de la barra.
    const originales = await prisma.orderItem.findMany({ where: { orderId: a.order.id } })
    for (const linea of repuesta.items) {
      const original = originales.find(o => o.productName === linea.productName)
      expect(linea.productId).toBe(original?.productId ?? null)
    }
  })

  it('…y si la comanda YA existe, el reintento no la duplica', async () => {
    const a = await ingestDeliveryOrder(pedido('ord-kds-ok'), link)
    await ingestDeliveryOrder(pedido('ord-kds-ok'), link)
    expect(await prisma.kdsOrder.count({ where: { orderId: a.order.id } })).toBe(1)
  })

  it('producto que NO resuelve ⇒ entra igual, ligado a un placeholder inactivo para re-mapear', async () => {
    // 🔴 Diferencia deliberada con la ingesta vieja de Uber, que dejaba `productId: null`.
    // El núcleo crea un producto placeholder INACTIVO en la categoría "Delivery (sin mapear)":
    // el pedido nunca se pierde Y la línea queda ligada a algo que el dueño puede re-mapear
    // desde el dashboard. Con `null` el renglón quedaba huérfano y no salía en ningún
    // reporte por producto.
    const { order } = await ingestDeliveryOrder(pedido('ord-6', 'producto-que-no-existe'), link)
    const items = await prisma.orderItem.findMany({ where: { orderId: order.id } })
    expect(items[0].productName).toBe('Cochinita') // el pedido NO se pierde
    expect(items[0].productId).not.toBeNull()

    const placeholder = await prisma.product.findUniqueOrThrow({ where: { id: items[0].productId! } })
    expect(placeholder.active).toBe(false) // inactivo: no se puede vender por error desde el POS
    const cat = await prisma.menuCategory.findUniqueOrThrow({ where: { id: placeholder.categoryId! } })
    expect(cat.slug).toBe('delivery-desconocido') // visible para el staff, en su propio cajón
  })

  it('rechaza si el split de dinero no cuadra (jamás inventa un cobro)', async () => {
    const malo = pedido('ord-7')
    malo.payment.externallyPaidSale = '999.00' // ya no cuadra con saleAmount + merchantFees
    await expect(ingestDeliveryOrder(malo, link)).rejects.toThrow(/no cuadra|invariante/i)
    expect(await prisma.order.count({ where: { venueId, externalId: 'UBER_EATS:ord-7' } })).toBe(0)
  })

  it('🔴 EL PEDIDO REAL de Uber, de punta a punta: JSON crudo → traductor → venta', async () => {
    // Cierra el círculo con el pedido que de verdad hizo Uber el 2026-08-20.
    const { mapUberOrder } = await import('@/services/delivery-channels/providers/uber-eats/uber.mapper')
    const crudo = await import('../../fixtures/delivery/uber/pedido-real-uapi.json')

    // Id único por corrida: la suite del processor ingiere el MISMO fixture y
    // `Order.externalId` es unique global — compartir id acopla las suites entre sí.
    const fixture = JSON.parse(JSON.stringify(crudo.default ?? crudo))
    fixture.order.id = `uapi-ing-${Date.now()}`
    const { order } = await ingestDeliveryOrder(mapUberOrder(fixture), link)

    expect(order.externalId).toBe(`UBER_EATS:${fixture.order.id}`)
    expect(order.orderNumber).toBe('EF5A9')
    expect(order.total.toString()).toBe('1') // MX$1.00 del Best Burger
    expect(order.tipAmount.toString()).toBe('0') // reparte Uber ⇒ la propina no llega al comercio

    const items = await prisma.orderItem.findMany({ where: { orderId: order.id } })
    expect(items).toHaveLength(1)
    expect(items[0].productName).toBe('Best Burger')
    expect(items[0].quantity).toBe(1)

    const p = await prisma.payment.findFirst({ where: { orderId: order.id } })
    expect(p!.amount.toString()).toBe('1')
    expect(p!.fundsFlow).toBe(PaymentFundsFlow.EXTERNAL_RECORDED)
  })
  // ── EL CONTRATO ────────────────────────────────────────────────────────────────────
  // Uber es hoy el único proveedor directo, así que es quien estrena la suite. Cuando
  // llegue Rappi o DiDi, su test invoca ESTA MISMA función: si la pasa, está integrado.
  let n = 0
  runIngestionContract(
    'Uber Eats',
    overrides => ({ ...pedido(`contrato-${++n}-${Date.now()}`), ...overrides }),
    () => link,
  )
})
