/**
 * Integration (REAL DB) — Tarea 13 del KDS de Uber: `reconcileDeliveryOrderFromProvider`, el
 * corazón del dinero (spec §3.1). El dinero sólo se mueve cuando una foto FRESCA del proveedor,
 * leída bajo el candado del pedido, ya no trae el renglón; y entonces se escribe un REEMBOLSO
 * PARCIAL compensatorio con los deltas EXACTOS del bloque `payment` y el reparto fiscal por tasa.
 */
import { DeliveryChannelLink, DeliveryProvider, OrderSource, Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { ingestDeliveryOrder } from '@/services/delivery-channels/core/deliveryOrderIngestion.service'
import { applyDeliveryRefund } from '@/services/delivery-channels/core/applyDeliveryRefund.service'
import { LECTURA_PROVEEDOR_MS, reconcileDeliveryOrderFromProvider } from '@/services/delivery-channels/core/deliveryReconciliation.service'
import { uberAdapter } from '@/services/delivery-channels/providers/uber-eats/uber.adapter'
import type { NormalizedDeliveryItem, NormalizedDeliveryOrder, NormalizedDeliveryPayment } from '@/services/delivery-channels/core/types'
import { CANDADO_TX_TIMEOUT_MS } from '@/services/delivery-channels/core/deliveryOrderLock'
import { grossByRateForOrder } from '@/services/fiscal/autoPosting.service'
import { ivaDeDevolucion } from '@/services/fiscal/deliveryFiscalDelta'
import { splitPaymentIvaByOrderRates } from '@/services/fiscal/ivaMath'
import { writeRefundInTx, type WriteRefundInput } from '@/services/shared/writeRefundInTx'

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

    // original − Σ compensaciones = composición superviviente, leído del sistema: los renglones
    // guardados (con su tasa y su marca de retiro) y el IVA que la póliza toma de cada REFUND.
    const renglones = await prisma.orderItem.findMany({
      where: { orderId: order.id },
      select: { quantity: true, unitPrice: true, discountAmount: true, removedAt: true, product: { select: { taxRate: true } } },
    })
    const mezcla = grossByRateForOrder(renglones)
    const ivaOriginal = splitPaymentIvaByOrderRates(20000, mezcla).taxCents
    const ivaSuperviviente = splitPaymentIvaByOrderRates(10000, grossByRateForOrder(renglones.filter(r => !r.removedAt))).taxCents
    const ivaDevuelto = refunds.reduce(
      (s, f) => s + ivaDeDevolucion(f.id, new Prisma.Decimal(f.amount).times(-100).toNumber(), f.processorData, mezcla).taxCents,
      0,
    )
    expect(ivaOriginal - ivaDevuelto).toBe(ivaSuperviviente)
    expect(ivaSuperviviente).toBe(1379)
  })

  it('P1-1: un reembolso manual intercalado entre dos retiros no deja IVA residual (sólo sobrevive el 0 %)', async () => {
    // Codex, auditoría final: A $100@16 %, B y C $100@0 %. Se retira B; devolución manual de $50
    // (IVA por la mezcla de la orden, como la póliza); se retira A. Sobrevive sólo C al 0 %:
    // el IVA que queda en libros tiene que ser CERO.
    const { order, foto } = await sembrar(
      [
        { linea: 'a', nombre: 'Taco', precio: '100.00' },
        { linea: 'b', nombre: 'Agua', precio: '100.00', tasa: 0 },
        { linea: 'c', nombre: 'Jugo', precio: '100.00', tasa: 0 },
      ],
      pago('300.00', '0.00'),
    )
    proveedorDevuelve(foto(['a', 'c'], pago('200.00', '0.00')))
    expect((await reconcileDeliveryOrderFromProvider(order.id, { trigger: 'ROUTE' })).outcome).toBe('REFUNDED')

    const original = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id, type: { not: 'REFUND' } } })
    await prisma.$transaction(tx =>
      writeRefundInTx(tx, {
        originalPaymentId: original.id,
        venueId,
        salesRefundCents: 5000,
        tipRefundCents: 0,
        refundedItems: [],
        reason: 'OTHER',
        tenderCommission: 'NONE',
        shift: 'INHERIT_ORIGINAL',
        provenance: 'MANUAL',
      }),
    )

    proveedorDevuelve(foto(['c'], pago('100.00', '0.00')))
    expect((await reconcileDeliveryOrderFromProvider(order.id, { trigger: 'ROUTE' })).outcome).toBe('REFUNDED')

    const refunds = await reembolsos(order.id)
    // N-6: el manual es INDEPENDIENTE, no entra al Δ: se compensa A completo y una persona revisa.
    expect(refunds.map(f => f.amount.toString())).toEqual(['-100', '-50', '-100'])
    expect(await prisma.activityLog.count({ where: { venueId, entityId: order.id, action: 'DELIVERY_REFUND_POSSIBLE_DUPLICATE' } })).toBe(1)
    // IVA en libros = el de la venta − el de cada devolución, cada uno como lo postea la póliza.
    const renglones = await prisma.orderItem.findMany({
      where: { orderId: order.id },
      select: { quantity: true, unitPrice: true, discountAmount: true, removedAt: true, product: { select: { taxRate: true } } },
    })
    const mezcla = grossByRateForOrder(renglones)
    const ivaVenta = splitPaymentIvaByOrderRates(30000, mezcla).taxCents
    const ivaDevuelto = refunds.reduce(
      (s, f) => s + ivaDeDevolucion(f.id, new Prisma.Decimal(f.amount).times(-100).toNumber(), f.processorData, mezcla).taxCents,
      0,
    )
    expect(ivaVenta - ivaDevuelto).toBe(0)
    const ivaManual = ivaDeDevolucion(refunds[1].id, 5000, refunds[1].processorData, mezcla).taxCents
    expect((refunds[2].processorData as any).fiscalByRateCents).toEqual({ '0.16': ivaVenta - ivaManual })
  })

  describe('deriva de redondeo (re-revisión, Minor): 1 centavo por tasa se absorbe; 2 siguen bloqueando', () => {
    const manual = async (orderId: string, cents: number) => {
      const original = await prisma.payment.findFirstOrThrow({ where: { orderId, type: { not: 'REFUND' } } })
      await prisma.$transaction(tx =>
        writeRefundInTx(tx, {
          originalPaymentId: original.id,
          venueId,
          salesRefundCents: cents,
          tipRefundCents: 0,
          refundedItems: [],
          reason: 'OTHER',
          tenderCommission: 'NONE',
          shift: 'INHERIT_ORIGINAL',
          provenance: 'MANUAL',
        }),
      )
    }

    it('N-6: manual del renglón retirado y DESPUÉS la compensación del proveedor ⇒ se escribe y queda la bandera', async () => {
      const { order, foto } = await sembrar(
        [
          { linea: 'a', nombre: 'Taco', precio: '75.00' },
          { linea: 'b', nombre: 'Torta', precio: '75.00' },
        ],
        pago('150.00', '0.00'),
      )
      await manual(order.id, 7500)
      proveedorDevuelve(foto(['a'], pago('75.00', '0.00')))
      const gritos = jest.spyOn(logger, 'error')

      expect((await reconcileDeliveryOrderFromProvider(order.id, { trigger: 'ROUTE' })).outcome).toBe('REFUNDED')

      const refunds = await reembolsos(order.id)
      expect(refunds.map(f => f.amount.toString())).toEqual(['-75', '-75'])
      expect(await prisma.activityLog.count({ where: { venueId, entityId: order.id, action: 'DELIVERY_REFUND_POSSIBLE_DUPLICATE' } })).toBe(1)
      // En libros quedan $0 de venta ⇒ $0 de IVA: la compensación descuenta el IVA de lo que el manual
      // no sacó ya, no el de la foto entera.
      const renglones = await prisma.orderItem.findMany({
        where: { orderId: order.id },
        select: { quantity: true, unitPrice: true, discountAmount: true, product: { select: { taxRate: true } } },
      })
      const mezcla = grossByRateForOrder(renglones)
      const ivaDevuelto = refunds.reduce(
        (t, f) => t + ivaDeDevolucion(f.id, new Prisma.Decimal(f.amount).times(-100).toNumber(), f.processorData, mezcla).taxCents,
        0,
      )
      expect(splitPaymentIvaByOrderRates(15000, mezcla).taxCents - ivaDevuelto).toBe(0)
      expect(gritos.mock.calls.some(([m]) => String(m).startsWith('🚨') && String(m).includes('posible doble registro'))).toBe(true)
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).deliveryReconcileBlocked).toBeNull()
    })

    it('Δ = 0 con 1 centavo de deriva por el redondeo del manual ⇒ NO_DELTA, sin bloquear', async () => {
      // $75 + $75 con descuento de $75 (se cobran $75); manual de $0.04; Uber retira b y quita el descuento.
      const { order, foto } = await sembrar(
        [
          { linea: 'a', nombre: 'Taco', precio: '75.00' },
          { linea: 'b', nombre: 'Torta', precio: '75.00' },
        ],
        pago('150.00', '75.00'),
      )
      await manual(order.id, 4)
      proveedorDevuelve(foto(['a'], pago('75.00', '0.00')))

      expect((await reconcileDeliveryOrderFromProvider(order.id, { trigger: 'ROUTE' })).outcome).toBe('NO_DELTA')
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).deliveryReconcileBlocked).toBeNull()
    })

    it('Δ de 1 centavo con IVA de −1 por redondeo ⇒ se compensa (REFUNDED), no FISCAL_PENDING', async () => {
      // $99.99 + $0.01; manual de $0.04; Uber retira el renglón de $0.01.
      const { order, foto } = await sembrar(
        [
          { linea: 'a', nombre: 'Taco', precio: '99.99' },
          { linea: 'b', nombre: 'Chicle', precio: '0.01' },
        ],
        pago('100.00', '0.00'),
      )
      await manual(order.id, 4)
      proveedorDevuelve(foto(['a'], pago('99.99', '0.00')))

      expect((await reconcileDeliveryOrderFromProvider(order.id, { trigger: 'ROUTE' })).outcome).toBe('REFUNDED')
      const ultimo = (await reembolsos(order.id)).pop()!
      expect(ultimo.amount.toString()).toBe('-0.01')
      expect((ultimo.processorData as any).fiscalByRateCents).toEqual({})
    })

    it('una reclasificación de 2 centavos NO es deriva: sigue FISCAL_PENDING', async () => {
      const { order, foto } = await sembrar(
        [
          { linea: 'a', nombre: 'Chicle', precio: '0.14' },
          { linea: 'b', nombre: 'Agua', precio: '100.00', tasa: 0 },
        ],
        pago('100.14', '0.14'),
      )
      proveedorDevuelve(foto(['b'], pago('100.00', '0.00')))

      expect((await reconcileDeliveryOrderFromProvider(order.id, { trigger: 'ROUTE' })).outcome).toBe('FISCAL_PENDING')
    })
  })

  describe('M-2/N-1: el reporte de pagos de Uber frente al ajuste del retiro', () => {
    const renglones: Renglon[] = [
      { linea: 'a', nombre: 'Cochinita', precio: '150.00' },
      { linea: 'b', nombre: 'Horchata', precio: '50.00' },
    ]
    const reporte = (order: { externalId: string | null }, monto: string) =>
      applyDeliveryRefund({ externalOrderId: order.externalId!.split(':')[1], provider: 'UBER_EATS', montoDevuelto: monto, motivo: 'reporte' })

    const bandera = (orderId: string) =>
      prisma.activityLog.count({ where: { venueId, entityId: orderId, action: 'DELIVERY_REFUND_POSSIBLE_DUPLICATE' } })

    it('N-1: un chargeback INDEPENDIENTE se escribe completo aunque haya un retiro compensado; una persona lo revisa', async () => {
      // Codex, 2ª pasada: $200; retiro de $50 ya compensado; Uber reembolsa $80 por OTRO artículo.
      // Restar el ajuste dejaba $120 en libros; deben quedar $70, con la duda a la vista.
      const { order, foto } = await sembrar(renglones, pago('200.00', '0.00'))
      proveedorDevuelve(foto(['a'], pago('150.00', '0.00')))
      expect((await reconcileDeliveryOrderFromProvider(order.id, { trigger: 'ROUTE' })).outcome).toBe('REFUNDED')
      const gritos = jest.spyOn(logger, 'error')

      expect((await reporte(order, '80.00')).outcome).toBe('APPLIED')

      expect((await reembolsos(order.id)).map(f => f.amount.toString())).toEqual(['-50', '-80'])
      const pagos = await prisma.payment.findMany({ where: { orderId: order.id }, select: { amount: true } })
      expect(pagos.reduce((t, p) => t.plus(p.amount), new Prisma.Decimal(0)).toString()).toBe('70')
      expect(await bandera(order.id)).toBe(1)
      expect(gritos.mock.calls.some(([m]) => String(m).startsWith('🚨') && String(m).includes('posible doble registro'))).toBe(true)
      // El mismo reporte otra vez no escribe ni vuelve a levantar la bandera.
      expect((await reporte(order, '80.00')).outcome).toBe('ALREADY_APPLIED')
      expect(await bandera(order.id)).toBe(1)
    })

    it('N-6: primero el chargeback, luego el retiro: la compensación se escribe y queda la bandera', async () => {
      const { order, foto } = await sembrar(renglones, pago('200.00', '0.00'))
      expect((await reporte(order, '50.00')).outcome).toBe('APPLIED')
      expect(await bandera(order.id)).toBe(0) // sin ajuste previo, el reporte no duda

      proveedorDevuelve(foto(['a'], pago('150.00', '0.00')))
      expect((await reconcileDeliveryOrderFromProvider(order.id, { trigger: 'ROUTE' })).outcome).toBe('REFUNDED')

      expect((await reembolsos(order.id)).map(f => f.amount.toString())).toEqual(['-50', '-50'])
      expect(await bandera(order.id)).toBe(1) // la reconciliación sí duda: hay un reembolso independiente
    })

    it('N-6 (Codex r4): tras un chargeback independiente completo, la relectura NO inventa un aumento', async () => {
      const { order, foto } = await sembrar(renglones, pago('200.00', '0.00'))
      proveedorDevuelve(foto(['a'], pago('150.00', '0.00')))
      expect((await reconcileDeliveryOrderFromProvider(order.id, { trigger: 'ROUTE' })).outcome).toBe('REFUNDED')
      expect((await reporte(order, '80.00')).outcome).toBe('APPLIED')

      proveedorDevuelve({ ...foto(['a'], pago('150.00', '0.00')), providerClosed: true })
      expect((await reconcileDeliveryOrderFromProvider(order.id, { trigger: 'WEBHOOK' })).outcome).toBe('PROVIDER_CLOSED')

      const o = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
      expect(o.deliveryReconcileBlocked).toBeNull()
      const pagos = await prisma.payment.findMany({ where: { orderId: order.id }, select: { amount: true } })
      expect(pagos.reduce((t, p) => t.plus(p.amount), new Prisma.Decimal(0)).toString()).toBe('70')
      expect((await reembolsos(order.id)).map(f => f.amount.toString())).toEqual(['-50', '-80'])
    })
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
    // I-1: el bloqueo deja rastro con su hora — de ahí cuenta la alerta de 24 h.
    expect(await prisma.activityLog.count({ where: { venueId, entityId: order.id, action: 'DELIVERY_ORDER_RECONCILE_BLOCKED' } })).toBe(1)
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
    expect(await prisma.activityLog.count({ where: { venueId, entityId: order.id, action: 'DELIVERY_ORDER_RECONCILE_BLOCKED' } })).toBe(1)
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

  // ── Ronda de endurecimiento ────────────────────────────────────────────────────────────────

  it('Q-2 (N-6): un reembolso del dashboard en vuelo se serializa con la reconciliación y levanta la bandera de posible doble registro', async () => {
    const { order, item, foto } = await sembrar(
      [
        { linea: 'a', nombre: 'Cochinita', precio: '150.00' },
        { linea: 'b', nombre: 'Horchata', precio: '50.00' },
      ],
      pago('200.00', '0.00'),
    )
    await accionConfirmada(order, item.b.id, 'b')
    const original = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id, type: { not: 'REFUND' } } })
    let avisar!: () => void
    const manualEscribio = new Promise<void>(r => (avisar = r))
    let manual: Promise<unknown> | undefined
    jest.spyOn(uberAdapter, 'normalizeOrder').mockImplementation(raw => raw as NormalizedDeliveryOrder)
    // Mientras el reconciliador espera a Uber, una persona devuelve los $50 desde el dashboard: su tx
    // toma `Order FOR UPDATE`, escribe el REFUND y tarda en confirmar.
    jest.spyOn(uberAdapter, 'fetchOrder').mockImplementation(async () => {
      manual = prisma.$transaction(async tx => {
        await writeRefundInTx(tx, {
          originalPaymentId: original.id,
          venueId,
          salesRefundCents: 5000,
          tipRefundCents: 0,
          refundedItems: [],
          reason: 'OTHER',
          tenderCommission: 'NONE',
          shift: 'INHERIT_ORIGINAL',
          provenance: 'MANUAL',
        })
        avisar()
        await new Promise(r => setTimeout(r, 500))
      })
      await manualEscribio
      return foto(['a'], pago('150.00', '0.00'))
    })

    const r = await reconcileDeliveryOrderFromProvider(order.id, { trigger: 'WEBHOOK' })
    await manual

    // N-6 (reemplaza la base (b) de T13): el manual en vuelo se VE —el candado lo serializa— pero NO
    // entra al Δ: la compensación se escribe y queda la bandera de posible doble registro.
    expect(r.outcome).toBe('REFUNDED')
    const refunds = await reembolsos(order.id)
    expect(refunds.map(f => (f.processorData as any).provenance)).toEqual(['MANUAL', 'PROVIDER_ADJUSTMENT'])
    expect((await accionDe(order.id, 'b')).settlement).toBe('REFUNDED')
    expect(await prisma.activityLog.count({ where: { venueId, entityId: order.id, action: 'DELIVERY_REFUND_POSSIBLE_DUPLICATE' } })).toBe(1)
  })

  it('Q-4: la llave del ajuste ya existía (fuera del filtro) con un Δ nuevo ⇒ 🚨 y lanza; nada se liquida', async () => {
    const { order, foto } = await sembrar(
      [
        { linea: 'a', nombre: 'Cochinita', precio: '150.00' },
        { linea: 'b', nombre: 'Horchata', precio: '50.00' },
      ],
      pago('200.00', '0.00'),
    )
    const original = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id, type: { not: 'REFUND' } } })
    // Un ajuste que no está COMPLETED no cuenta para la generación, pero su llave `dlr:<orden>:1` sí existe.
    const viejo = await prisma.payment.create({
      data: {
        venueId,
        orderId: order.id,
        amount: 0,
        tipAmount: 0,
        method: 'OTHER',
        status: 'PENDING',
        type: 'REFUND',
        splitType: 'FULLPAYMENT',
        source: 'DELIVERY_PLATFORM',
        feePercentage: 0,
        feeAmount: 0,
        netAmount: 0,
        idempotencyKey: `dlr:${order.id}:1`,
        processorData: { originalPaymentId: original.id, provenance: 'PROVIDER_ADJUSTMENT' },
      },
    })
    proveedorDevuelve(foto(['a'], pago('150.00', '0.00')))

    await expect(reconcileDeliveryOrderFromProvider(order.id, { trigger: 'JOB' })).rejects.toThrow(/replay/)

    expect(await prisma.payment.count({ where: { orderId: order.id, type: 'REFUND', id: { not: viejo.id } } })).toBe(0)
    expect(await prisma.deliveryLineAction.count({ where: { orderId: order.id } })).toBe(0)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).total.toString()).toBe('200')
  })

  it('Q-1: detrás de una lectura lenta que retiene el candado, la segunda acorta su plazo y devuelve READ_FAILED sin tronar', async () => {
    const { order, item } = await sembrar(
      [
        { linea: 'a', nombre: 'Cochinita', precio: '150.00' },
        { linea: 'b', nombre: 'Horchata', precio: '50.00' },
      ],
      pago('200.00', '0.00'),
    )
    await accionConfirmada(order, item.b.id, 'b')
    jest.spyOn(uberAdapter, 'fetchOrder').mockImplementation(() => new Promise(() => undefined))

    const t0 = Date.now()
    const rs = await Promise.all([
      reconcileDeliveryOrderFromProvider(order.id, { trigger: 'ROUTE' }),
      reconcileDeliveryOrderFromProvider(order.id, { trigger: 'WEBHOOK' }),
    ])

    expect(rs.map(x => x.outcome)).toEqual(['READ_FAILED', 'READ_FAILED'])
    expect(Date.now() - t0).toBeLessThan(CANDADO_TX_TIMEOUT_MS)
    expect(await prisma.payment.count({ where: { orderId: order.id, type: 'REFUND' } })).toBe(0)
    expect(await accionDe(order.id, 'b')).toMatchObject({ status: 'CONFIRMED', settlement: 'PENDING' })
  }, 40_000)

  it('Q-9: dos reconciliaciones con fotos DISTINTAS: la que toma el candado después usa SU foto, más fresca', async () => {
    const { order, item, foto } = await sembrar(
      [
        { linea: 'a', nombre: 'Cochinita', precio: '100.00' },
        { linea: 'b', nombre: 'Horchata', precio: '50.00' },
        { linea: 'c', nombre: 'Agua', precio: '50.00' },
      ],
      pago('200.00', '0.00'),
    )
    const fotoSinB = foto(['a', 'c'], pago('150.00', '0.00'))
    const fotoSinByC = foto(['a'], pago('100.00', '0.00'))
    jest.spyOn(uberAdapter, 'normalizeOrder').mockImplementation(raw => raw as NormalizedDeliveryOrder)
    // La primera lectura tarda: si alguien leyera FUERA del candado, la segunda (más fresca) llegaría antes.
    jest
      .spyOn(uberAdapter, 'fetchOrder')
      .mockImplementationOnce(() => new Promise(r => setTimeout(() => r(fotoSinB), 200)))
      .mockResolvedValueOnce(fotoSinByC)

    const rs = await Promise.all([
      reconcileDeliveryOrderFromProvider(order.id, { trigger: 'ROUTE' }),
      reconcileDeliveryOrderFromProvider(order.id, { trigger: 'WEBHOOK' }),
    ])

    expect(rs.map(x => x.outcome)).toEqual(['REFUNDED', 'REFUNDED'])
    const refunds = await reembolsos(order.id)
    expect(refunds.map(f => f.amount.toString())).toEqual(['-50', '-50'])
    expect(refunds.map(f => (f.processorData as any).refundedItems.map((i: any) => i.orderItemId))).toEqual([[item.b.id], [item.c.id]])
    expect((refunds[1].processorData as any).generation).toBe(2)
    const o = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(o.total.toString()).toBe('100')
    expect(o.deliveryReconcileBlocked).toBeNull()
  })

  it('Q-5: un ajuste del proveedor sin generación ni reparto fiscal no compila', () => {
    // @ts-expect-error — `generation` y `fiscalByRateCents` son obligatorios con PROVIDER_ADJUSTMENT
    const incompleto: WriteRefundInput = {
      originalPaymentId: 'p',
      venueId: 'v',
      salesRefundCents: 1,
      tipRefundCents: 0,
      refundedItems: [],
      reason: 'DELIVERY_ITEM_REMOVED',
      tenderCommission: 'NONE',
      shift: 'INHERIT_ORIGINAL',
      provenance: 'PROVIDER_ADJUSTMENT',
    }
    expect(incompleto.provenance).toBe('PROVIDER_ADJUSTMENT')
  })
})
