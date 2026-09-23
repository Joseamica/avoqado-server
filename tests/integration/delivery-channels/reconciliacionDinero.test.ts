/**
 * Integration (REAL DB) — Tarea 13 del KDS de Uber: `reconcileDeliveryOrderFromProvider`, el
 * corazón del dinero (spec §3.1). El dinero sólo se mueve cuando una foto FRESCA del proveedor,
 * leída bajo el candado del pedido, ya no trae el renglón; y entonces se escribe un REEMBOLSO
 * PARCIAL compensatorio con los deltas EXACTOS del bloque `payment` y el reparto fiscal por tasa.
 */
import { DeliveryChannelLink, DeliveryProvider, OrderSource, Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ingestDeliveryOrder } from '@/services/delivery-channels/core/deliveryOrderIngestion.service'
import { LECTURA_PROVEEDOR_MS, reconcileDeliveryOrderFromProvider } from '@/services/delivery-channels/core/deliveryReconciliation.service'
import { uberAdapter } from '@/services/delivery-channels/providers/uber-eats/uber.adapter'
import type { NormalizedDeliveryItem, NormalizedDeliveryOrder, NormalizedDeliveryPayment } from '@/services/delivery-channels/core/types'

type Renglon = { linea: string; nombre: string; precio: string; tasa?: number }

describe('reconcileDeliveryOrderFromProvider (Tarea 13)', () => {
  let venueId: string, orgId: string
  let link: DeliveryChannelLink
  let n = 0

  const renglon = (r: Renglon, sufijo: number): NormalizedDeliveryItem => ({
    externalId: `${r.linea}-${sufijo}`,
    lineId: r.linea,
    name: `${r.nombre} ${sufijo}`,
    quantity: 1,
    unitPrice: r.precio,
    total: r.precio,
  })

  const pago = (venta: string, descuento: string, propina = '0.00'): NormalizedDeliveryPayment => {
    const cobrado = new Prisma.Decimal(venta).minus(descuento).toFixed(2)
    return {
      currency: 'MXN',
      saleAmount: venta,
      merchantFees: '0.00',
      discountAmount: descuento,
      tipAmount: propina,
      externallyPaidSale: cobrado,
      externallyPaidTip: propina,
      cashDueSale: '0.00',
      cashDueTip: '0.00',
    }
  }

  /**
   * Una venta de reparto como la deja la ingesta real. Devuelve también `foto(...)`, que arma la
   * foto del proveedor con los renglones que SIGUEN y el nuevo bloque de dinero.
   */
  async function sembrar(renglones: Renglon[], p: NormalizedDeliveryPayment) {
    const sufijo = ++n
    const externalId = `recon-${Date.now()}-${sufijo}`
    const normalized: NormalizedDeliveryOrder = {
      externalId,
      displayId: `RC${sufijo}`,
      source: OrderSource.UBER_EATS,
      items: renglones.map(r => renglon(r, sufijo)),
      payment: p,
      customer: { name: 'Cliente T13' },
      raw: { fuente: 'test' },
      placedAt: new Date(),
    }
    const { order } = await ingestDeliveryOrder(normalized, link)
    const filas = await prisma.orderItem.findMany({ where: { orderId: order.id } })
    const item: Record<string, (typeof filas)[number]> = {}
    for (const f of filas) item[f.externalLineId!] = f
    for (const r of renglones) {
      if (r.tasa !== undefined) await prisma.product.update({ where: { id: item[r.linea].productId! }, data: { taxRate: r.tasa } })
    }
    const foto = (
      siguen: string[],
      nuevo: NormalizedDeliveryPayment,
      extra: Partial<NormalizedDeliveryOrder> = {},
    ): NormalizedDeliveryOrder => ({
      ...normalized,
      items: renglones.filter(r => siguen.includes(r.linea)).map(r => renglon(r, sufijo)),
      payment: nuevo,
      ...extra,
    })
    return { order, item, foto }
  }

  /** El proveedor contesta ESTA foto (el adaptador real, con su GET y su mapper reemplazados). */
  const proveedorDevuelve = (foto: NormalizedDeliveryOrder) => {
    jest.spyOn(uberAdapter, 'fetchOrder').mockResolvedValue(foto)
    jest.spyOn(uberAdapter, 'normalizeOrder').mockImplementation(raw => raw as NormalizedDeliveryOrder)
  }

  /** Lo que T14 deja tras un 2xx de Uber: el retiro pedido por el cajero, aún sin acreditar. */
  const accionConfirmada = (order: { id: string; externalId: string | null }, orderItemId: string, lineId: string) =>
    prisma.deliveryLineAction.create({
      data: {
        venueId,
        orderId: order.id,
        orderItemId,
        provider: DeliveryProvider.UBER_EATS,
        externalOrderId: order.externalId!.split(':')[1],
        storeId: link.externalLocationId,
        lineId,
        action: 'REMOVE_ITEM',
        status: 'CONFIRMED',
        origin: 'STAFF',
      },
    })

  const reembolsos = (orderId: string) => prisma.payment.findMany({ where: { orderId, type: 'REFUND' }, orderBy: { createdAt: 'asc' } })
  const accionDe = (orderId: string, lineId: string) => prisma.deliveryLineAction.findFirstOrThrow({ where: { orderId, lineId } })

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: `Org recon ${Date.now()}`, email: `recon${Date.now()}@t.mx`, phone: '5555555555' },
    })
    orgId = org.id
    const v = await prisma.venue.create({ data: { organizationId: orgId, name: `V recon ${Date.now()}`, slug: `v-recon-${Date.now()}` } })
    venueId = v.id
    link = await prisma.deliveryChannelLink.create({
      data: { venueId, provider: DeliveryProvider.UBER_EATS, externalLocationId: `store-recon-${Date.now()}`, webhookSecret: 'x' },
    })
  })

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    try {
      const ids = (await prisma.order.findMany({ where: { venueId }, select: { id: true } })).map(o => o.id)
      const pagos = (await prisma.payment.findMany({ where: { venueId }, select: { id: true } })).map(p => p.id)
      await prisma.deliveryLineAction.deleteMany({ where: { venueId } })
      await prisma.activityLog.deleteMany({ where: { venueId } })
      await prisma.venueTransaction.deleteMany({ where: { venueId } })
      await prisma.paymentEffect.deleteMany({ where: { paymentId: { in: pagos } } })
      await prisma.paymentAllocation.deleteMany({ where: { paymentId: { in: pagos } } })
      await prisma.payment.deleteMany({ where: { venueId } })
      await prisma.orderItemModifier.deleteMany({ where: { orderItem: { orderId: { in: ids } } } })
      await prisma.kdsOrder.deleteMany({ where: { venueId } })
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
      /* fixtures */
    }
  })

  it('retiro de 50 con descuento que baja de 20 a 15 ⇒ REFUND de 45, no de 50, y la orden refleja al proveedor', async () => {
    const { order, item, foto } = await sembrar(
      [
        { linea: 'a', nombre: 'Cochinita', precio: '150.00' },
        { linea: 'b', nombre: 'Horchata', precio: '50.00' },
      ],
      pago('200.00', '20.00'),
    )
    proveedorDevuelve(foto(['a'], pago('150.00', '15.00'), { providerAccepted: true }))

    const r = await reconcileDeliveryOrderFromProvider(order.id, { trigger: 'ROUTE' })

    expect(r.outcome).toBe('REFUNDED')
    const [refund] = await reembolsos(order.id)
    expect(refund.amount.toString()).toBe('-45')
    expect(refund.tipAmount.toString()).toBe('0')
    expect(refund.idempotencyKey).toBe(`dlr:${order.id}:1`)
    expect(refund.shiftId).toBeNull()
    expect(refund.processorData).toMatchObject({
      refundReason: 'DELIVERY_ITEM_REMOVED',
      provenance: 'PROVIDER_ADJUSTMENT',
      providerAdjustment: true,
      generation: 1,
      refundedItems: [{ orderItemId: item.b.id, quantity: 1, amountCents: 5000 }],
    })
    const o = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(o.total.toString()).toBe('135')
    expect(o.subtotal.toString()).toBe('150')
    expect(o.discountAmount.toString()).toBe('15')
    expect(o.paidAmount.toString()).toBe('135')
    expect(o.remainingBalance.toString()).toBe('0')
    expect(o.providerAcceptedEvidence).toBe('PROVIDER_STATE')
    expect(o.deliveryReconcileBlocked).toBeNull()
    const accion = await accionDe(order.id, 'b')
    expect(accion).toMatchObject({ status: 'CONFIRMED', settlement: 'REFUNDED', refundPaymentId: refund.id, origin: 'PROVIDER' })
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: item.b.id } })).removedAt).not.toBeNull()
    expect(await prisma.activityLog.count({ where: { venueId, entityId: order.id, action: 'DELIVERY_ORDER_REPRICED' } })).toBe(1)
  })

  it('la linea SIGUE presente ⇒ CONFIRMED/PENDING, cero dinero, sigue en el barrido', async () => {
    const { order, item, foto } = await sembrar(
      [
        { linea: 'a', nombre: 'Cochinita', precio: '150.00' },
        { linea: 'b', nombre: 'Horchata', precio: '50.00' },
      ],
      pago('200.00', '0.00'),
    )
    await accionConfirmada(order, item.b.id, 'b')
    proveedorDevuelve(foto(['a', 'b'], pago('200.00', '0.00')))

    const r = await reconcileDeliveryOrderFromProvider(order.id, { trigger: 'JOB' })

    expect(r.outcome).toBe('NO_ACTIONS')
    expect(await prisma.payment.count({ where: { orderId: order.id, type: 'REFUND' } })).toBe(0)
    expect((await accionDe(order.id, 'b')).settlement).toBe('PENDING')
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: item.b.id } })).removedAt).toBeNull()
  })

  it('una accion ya REFUNDED no entra a la generacion 2, y original − Σ compensaciones = composicion superviviente', async () => {
    const { order, item, foto } = await sembrar(
      [
        { linea: 'a', nombre: 'Taco', precio: '50.00' },
        { linea: 'b', nombre: 'Agua', precio: '50.00', tasa: 0 },
        { linea: 'c', nombre: 'Torta', precio: '100.00' },
      ],
      pago('200.00', '0.00'),
    )
    proveedorDevuelve(foto(['b', 'c'], pago('150.00', '0.00')))
    expect((await reconcileDeliveryOrderFromProvider(order.id, { trigger: 'ROUTE' })).outcome).toBe('REFUNDED')

    // A liquidada; ahora se retira B y la foto muestra A y B ausentes.
    proveedorDevuelve(foto(['c'], pago('100.00', '0.00')))
    const r = await reconcileDeliveryOrderFromProvider(order.id, { trigger: 'ROUTE' })

    expect(r.outcome).toBe('REFUNDED')
    const refunds = await reembolsos(order.id)
    expect(refunds).toHaveLength(2)
    expect((refunds[1].processorData as any).refundedItems.map((i: any) => i.orderItemId)).toEqual([item.b.id])
    expect((refunds[1].processorData as any).generation).toBe(2)
    expect(refunds[1].idempotencyKey).toBe(`dlr:${order.id}:2`)
    // La liquidación de A es terminal: su reembolso no se reescribe.
    expect(await accionDe(order.id, 'a')).toMatchObject({ settlement: 'REFUNDED', refundPaymentId: refunds[0].id })
    expect(await accionDe(order.id, 'b')).toMatchObject({ settlement: 'REFUNDED', refundPaymentId: refunds[1].id })
    // IVA de la venta al 16 %: $200 sobre {16 %: 150, 0 %: 50} = 20.69; superviviente (Torta $100) = 13.79.
    const fiscales = refunds.map(f => (f.processorData as any).fiscalByRateCents)
    expect(fiscales).toEqual([{ '0.16': 690 }, {}])
    expect(2069 - 690 - 0).toBe(1379)
  })

  it('sube la propina ⇒ nada escrito, deliveryReconcileBlocked = INCREASE_UNSUPPORTED, y bloqueado no mueve dinero', async () => {
    const { order, foto } = await sembrar(
      [
        { linea: 'a', nombre: 'Cochinita', precio: '150.00' },
        { linea: 'b', nombre: 'Horchata', precio: '50.00' },
      ],
      pago('200.00', '0.00', '20.00'),
    )
    proveedorDevuelve(foto(['a'], pago('150.00', '0.00', '30.00')))

    const r = await reconcileDeliveryOrderFromProvider(order.id, { trigger: 'ROUTE' })

    expect(r.outcome).toBe('BLOCKED_INCREASE')
    expect(await prisma.payment.count({ where: { orderId: order.id, type: 'REFUND' } })).toBe(0)
    const o = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(o.deliveryReconcileBlocked).toBe('INCREASE_UNSUPPORTED')
    expect(o.total.toString()).toBe('200')
    // La ausencia SÍ quedó acreditada: sigue en el barrido hasta que una persona decida.
    expect((await accionDe(order.id, 'b')).settlement).toBe('ACCREDITED')

    // Aunque la foto siguiente se vea sana, el pedido bloqueado espera a una persona.
    proveedorDevuelve(foto(['a'], pago('150.00', '0.00', '20.00')))
    expect((await reconcileDeliveryOrderFromProvider(order.id, { trigger: 'JOB' })).outcome).toBe('BLOCKED_INCREASE')
    expect(await prisma.payment.count({ where: { orderId: order.id, type: 'REFUND' } })).toBe(0)
  })

  it('deltas 0 con composicion fiscal distinta ⇒ FISCAL_PENDING, nunca NO_DELTA', async () => {
    // $100@16% + $100@0% con descuento $100 → sobrevive el de 0% sin descuento: cobrado $100 en ambos, IVA 6.90 → 0
    const { order, foto } = await sembrar(
      [
        { linea: 'a', nombre: 'Taco', precio: '100.00' },
        { linea: 'b', nombre: 'Agua', precio: '100.00', tasa: 0 },
      ],
      pago('200.00', '100.00'),
    )
    proveedorDevuelve(foto(['b'], pago('100.00', '0.00')))

    const r = await reconcileDeliveryOrderFromProvider(order.id, { trigger: 'ROUTE' })

    expect(r.outcome).toBe('FISCAL_PENDING')
    const o = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(o.deliveryReconcileBlocked).toBe('FISCAL_RECLASS_UNSUPPORTED')
    expect(await prisma.payment.count({ where: { orderId: order.id, type: 'REFUND' } })).toBe(0)
    expect((await accionDe(order.id, 'a')).settlement).toBe('FISCAL_PENDING')
  })

  it('deltas 0 y fiscal 0 ⇒ NO_DELTA, y la orden refleja al proveedor', async () => {
    const { order, foto } = await sembrar(
      [
        { linea: 'a', nombre: 'Taco', precio: '50.00' },
        { linea: 'b', nombre: 'Torta', precio: '50.00' },
      ],
      pago('100.00', '50.00'),
    )
    proveedorDevuelve(foto(['b'], pago('50.00', '0.00')))

    const r = await reconcileDeliveryOrderFromProvider(order.id, { trigger: 'ROUTE' })

    expect(r.outcome).toBe('NO_DELTA')
    expect(await prisma.payment.count({ where: { orderId: order.id, type: 'REFUND' } })).toBe(0)
    expect((await accionDe(order.id, 'a')).settlement).toBe('NO_DELTA')
    const o = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(o.deliveryReconcileBlocked).toBeNull()
    expect(o.subtotal.toString()).toBe('50')
    expect(o.discountAmount.toString()).toBe('0')
    expect(o.total.toString()).toBe('50')
  })

  it('Q1bis: IVA devuelto negativo por tasa (la promo desaparece al retirar el exento) ⇒ FISCAL_PENDING, sin REFUND', async () => {
    // Cobrado [100@16% con descuento 50, 100@0%] = $150; sobrevive [100@16%] a $100 ⇒ Δventa 50,
    // pero el IVA al 16 % SUBE de 6.90 a 13.79: el reparto sería −6.89, que no existe como REFUND.
    const { order, item, foto } = await sembrar(
      [
        { linea: 'a', nombre: 'Taco', precio: '100.00' },
        { linea: 'b', nombre: 'Agua', precio: '100.00', tasa: 0 },
      ],
      pago('200.00', '50.00'),
    )
    await prisma.orderItem.update({ where: { id: item.a.id }, data: { discountAmount: 50 } })
    proveedorDevuelve(foto(['a'], pago('100.00', '0.00')))

    const r = await reconcileDeliveryOrderFromProvider(order.id, { trigger: 'ROUTE' })

    expect(r.outcome).toBe('FISCAL_PENDING')
    expect(await prisma.payment.count({ where: { orderId: order.id, type: 'REFUND' } })).toBe(0)
    const o = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(o.deliveryReconcileBlocked).toBe('FISCAL_RECLASS_UNSUPPORTED')
    expect(o.total.toString()).toBe('150')
    expect((await accionDe(order.id, 'b')).settlement).toBe('FISCAL_PENDING')

    // Otra pasada no lo "resuelve" sola devolviendo el dinero con un reparto inventado.
    expect((await reconcileDeliveryOrderFromProvider(order.id, { trigger: 'JOB' })).outcome).toBe('FISCAL_PENDING')
    expect(await prisma.payment.count({ where: { orderId: order.id, type: 'REFUND' } })).toBe(0)
  })

  it('baja sólo la propina con un retiro aún PENDING ⇒ REFUND de propina con refundedItems vacío; el retiro espera', async () => {
    const { order, item, foto } = await sembrar(
      [
        { linea: 'a', nombre: 'Cochinita', precio: '150.00' },
        { linea: 'b', nombre: 'Horchata', precio: '50.00' },
      ],
      pago('200.00', '0.00', '20.00'),
    )
    await accionConfirmada(order, item.b.id, 'b')
    proveedorDevuelve(foto(['a', 'b'], pago('200.00', '0.00', '10.00')))

    const r = await reconcileDeliveryOrderFromProvider(order.id, { trigger: 'WEBHOOK' })

    expect(r.outcome).toBe('REFUNDED')
    const [refund] = await reembolsos(order.id)
    expect(refund.amount.toString()).toBe('0')
    expect(refund.tipAmount.toString()).toBe('-10')
    expect((refund.processorData as any).refundedItems).toEqual([])
    expect((await accionDe(order.id, 'b')).settlement).toBe('PENDING')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).tipAmount.toString()).toBe('10')
  })

  it('el GET que falla no escribe NADA y deja la accion intacta', async () => {
    const { order, item } = await sembrar(
      [
        { linea: 'a', nombre: 'Cochinita', precio: '150.00' },
        { linea: 'b', nombre: 'Horchata', precio: '50.00' },
      ],
      pago('200.00', '0.00'),
    )
    await accionConfirmada(order, item.b.id, 'b')
    jest.spyOn(uberAdapter, 'fetchOrder').mockImplementation(() => new Promise((_, rej) => setTimeout(() => rej(new Error('abort')), 10)))

    const r = await reconcileDeliveryOrderFromProvider(order.id, { trigger: 'JOB' })

    expect(r.outcome).toBe('READ_FAILED')
    expect(await prisma.payment.count({ where: { orderId: order.id, type: 'REFUND' } })).toBe(0)
    expect(await accionDe(order.id, 'b')).toMatchObject({ status: 'CONFIRMED', settlement: 'PENDING' })
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: item.b.id } })).removedAt).toBeNull()
  })

  it(`el GET que nunca contesta se corta a los ${LECTURA_PROVEEDOR_MS} ms bajo el candado y no escribe NADA`, async () => {
    const { order, item } = await sembrar(
      [
        { linea: 'a', nombre: 'Cochinita', precio: '150.00' },
        { linea: 'b', nombre: 'Horchata', precio: '50.00' },
      ],
      pago('200.00', '0.00'),
    )
    await accionConfirmada(order, item.b.id, 'b')
    let senal: AbortSignal | undefined
    // Un proveedor que ignora la señal: el límite tiene que valer igual.
    jest.spyOn(uberAdapter, 'fetchOrder').mockImplementation((_id: string, s?: AbortSignal) => {
      senal = s
      return new Promise(() => undefined)
    })

    const t0 = Date.now()
    const r = await reconcileDeliveryOrderFromProvider(order.id, { trigger: 'JOB' })
    const ms = Date.now() - t0

    expect(r.outcome).toBe('READ_FAILED')
    expect(ms).toBeGreaterThanOrEqual(LECTURA_PROVEEDOR_MS - 100)
    expect(ms).toBeLessThan(LECTURA_PROVEEDOR_MS + 5_000)
    expect(senal?.aborted).toBe(true)
    expect(await prisma.payment.count({ where: { orderId: order.id, type: 'REFUND' } })).toBe(0)
    expect(await accionDe(order.id, 'b')).toMatchObject({ status: 'CONFIRMED', settlement: 'PENDING' })
  }, 25_000)

  it('nunca acepta una foto del caller: dos reconciliaciones a la vez leen la foto fresca bajo el candado ⇒ un solo REFUND', async () => {
    const { order, foto } = await sembrar(
      [
        { linea: 'a', nombre: 'Cochinita', precio: '150.00' },
        { linea: 'b', nombre: 'Horchata', precio: '50.00' },
      ],
      pago('200.00', '20.00'),
    )
    proveedorDevuelve(foto(['a'], pago('150.00', '15.00')))

    const rs = await Promise.all([
      reconcileDeliveryOrderFromProvider(order.id, { trigger: 'ROUTE' }),
      reconcileDeliveryOrderFromProvider(order.id, { trigger: 'WEBHOOK' }),
    ])

    expect(rs.map(x => x.outcome).sort()).toEqual(['NO_ACTIONS', 'REFUNDED'])
    const refunds = await reembolsos(order.id)
    expect(refunds).toHaveLength(1)
    expect(refunds[0].amount.toString()).toBe('-45')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).total.toString()).toBe('135')
  })

  it('replay: la misma reconciliación dos veces escribe UN solo REFUND', async () => {
    const { order, foto } = await sembrar(
      [
        { linea: 'a', nombre: 'Cochinita', precio: '150.00' },
        { linea: 'b', nombre: 'Horchata', precio: '50.00' },
      ],
      pago('200.00', '0.00'),
    )
    proveedorDevuelve(foto(['a'], pago('150.00', '0.00')))

    expect((await reconcileDeliveryOrderFromProvider(order.id, { trigger: 'ROUTE' })).outcome).toBe('REFUNDED')
    expect((await reconcileDeliveryOrderFromProvider(order.id, { trigger: 'JOB' })).outcome).toBe('NO_ACTIONS')

    const refunds = await reembolsos(order.id)
    expect(refunds).toHaveLength(1)
    expect(refunds[0].amount.toString()).toBe('-50')
    expect(await prisma.activityLog.count({ where: { venueId, entityId: order.id, action: 'DELIVERY_ORDER_REPRICED' } })).toBe(1)
  })
})
