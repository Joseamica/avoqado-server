/**
 * Ingesta de un pedido de Uber Eats → venta de Avoqado (spec paso 7).
 *
 * Camino PROPIO de Uber: no reusa `core/deliveryOrderIngestion.service.ts`, que
 * es de Deliverect y está congelado por decisión del founder. Ese core además
 * arrastra defectos conocidos (decide "pagado" leyendo un campo de Deliverect,
 * cuenta la propina dos veces) que aquí no se heredan.
 *
 * TODO nace en UNA transacción: Order, líneas, modificadores, Payment y el
 * posting de inventario. Si algo falla, no queda media venta.
 *
 * Idempotente por `Order.externalId` namespaceado (`UBER_EATS:{id}`): el unique
 * es por venue `[código]` y dos proveedores pueden repetir número de pedido.
 */
import { Prisma, DeliveryProvider, OrderSource, OriginSystem, OrderStatus, PaymentStatus, PaymentMethod, PaymentFundsFlow, PaymentSource, SplitType, TransactionStatus } from '@prisma/client'
import prisma from '../../../../utils/prismaClient'
import logger from '../../../../config/logger'
import { createSalePostingInTx, applySalePosting } from '../../../inventory/inventoryPosting.service'
import { ensureDeliveryTenderType } from '../../core/deliveryTenderProvisioning.service'
import { resolveUberProduct } from './uber.productResolver'
import type { NormalizedUberOrder } from './uber.types'

export const UBER_ORDER_PREFIX = 'UBER_EATS:'

export interface UberIngestContext {
  linkId: string
  venueId: string
}

export interface UberIngestResult {
  orderId: string
  alreadyExisted: boolean
  /** Líneas cuyo producto no se pudo resolver: la orden queda para revisión. */
  unresolvedItems: number
}

const D = (v: string) => new Prisma.Decimal(v)

/**
 * Verifica el split del mapper con igualdad EXACTA tras cuantizar a 2 decimales.
 * Sin tolerancia: un centavo por pedido, a volumen, es dinero real.
 */
function assertMoneyInvariants(p: NormalizedUberOrder['payment']): void {
  const q = (d: Prisma.Decimal) => d.toDecimalPlaces(2)
  const ventaTotal = q(D(p.saleAmount).plus(D(p.merchantFees)))
  const ventaSplit = q(D(p.externallyPaidSale).plus(D(p.cashDueSale)))
  if (!ventaTotal.equals(ventaSplit)) {
    throw new Error(`Invariante de dinero no cuadra: saleAmount+merchantFees (${ventaTotal}) ≠ externallyPaidSale+cashDueSale (${ventaSplit})`)
  }
  const propina = q(D(p.tipAmount))
  const propinaSplit = q(D(p.externallyPaidTip).plus(D(p.cashDueTip)))
  if (!propina.equals(propinaSplit)) {
    throw new Error(`Invariante de dinero no cuadra: tipAmount (${propina}) ≠ externallyPaidTip+cashDueTip (${propinaSplit})`)
  }
  for (const [k, v] of Object.entries(p)) {
    if (k === 'currency') continue
    const d = D(v as string)
    if (!d.isFinite() || d.isNegative()) throw new Error(`Monto inválido en el split: ${k}=${v}`)
  }
  if (p.currency !== 'MXN') throw new Error(`Moneda no soportada: ${p.currency}`)
}

export async function ingestUberOrder(normalized: NormalizedUberOrder, ctx: UberIngestContext): Promise<UberIngestResult> {
  assertMoneyInvariants(normalized.payment)

  const externalId = `${UBER_ORDER_PREFIX}${normalized.externalId}`

  // Idempotencia: si ya la ingerimos, se devuelve tal cual (Uber reintenta).
  const existente = await prisma.order.findUnique({
    where: { venueId_externalId: { venueId: ctx.venueId, externalId } },
    select: { id: true },
  })
  if (existente) return { orderId: existente.id, alreadyExisted: true, unresolvedItems: 0 }

  // El tender del canal se autoprovisiona ANTES de la transacción: es idempotente
  // y no debe alargar el lock de la venta.
  const tender = await ensureDeliveryTenderType(ctx.venueId, DeliveryProvider.UBER_EATS)

  // Resolver productos fuera de la transacción (son lecturas).
  const resueltos = await Promise.all(
    normalized.items.map(async it => ({
      item: it,
      resolution: await resolveUberProduct(ctx.venueId, { id: it.externalId, externalData: it.externalData ?? null }),
    })),
  )
  const unresolvedItems = resueltos.filter(r => r.resolution.productId === null).length

  const p = normalized.payment
  const subtotal = D(p.saleAmount)
  const merchantFees = D(p.merchantFees)
  const tip = D(p.tipAmount)
  // Semántica canónica (igual que el cobro rápido de TPV): el total INCLUYE propina.
  const total = subtotal.plus(merchantFees).plus(tip)
  const pagadoExterno = D(p.externallyPaidSale).plus(D(p.externallyPaidTip))
  const porCobrar = D(p.cashDueSale).plus(D(p.cashDueTip))
  const paymentStatus = porCobrar.isZero() ? PaymentStatus.PAID : pagadoExterno.isZero() ? PaymentStatus.PENDING : PaymentStatus.PARTIAL

  const postingState: { id: string | null } = { id: null }

  const orderId = await prisma.$transaction(async tx => {
    const order = await tx.order.create({
      data: {
        venueId: ctx.venueId,
        orderNumber: normalized.displayId,
        externalId,
        source: OrderSource.UBER_EATS,
        originSystem: OriginSystem.DELIVERY_PLATFORM,
        status: OrderStatus.CONFIRMED,
        paymentStatus,
        subtotal,
        // La plataforma guarda 0 en toda línea; el impuesto de Uber NO es fuente
        // de verdad fiscal (llega mal capturado por el comercio).
        taxAmount: new Prisma.Decimal(0),
        tipAmount: tip,
        total,
        paidAmount: pagadoExterno,
        remainingBalance: porCobrar,
        // Sin mesero ni turno: un pedido de delivery no pertenece a ninguno.
        servedById: null,
        shiftId: null,
        posRawData: normalized.raw as Prisma.InputJsonValue,
      },
      select: { id: true },
    })

    const creados = []
    for (const { item, resolution } of resueltos) {
      const li = await tx.orderItem.create({
        data: {
          orderId: order.id,
          productId: resolution.productId, // null si no resolvió: la línea NO se pierde
          productName: item.name,          // snapshot: sobrevive aunque el producto cambie
          productSku: item.externalData ?? null,
          quantity: item.quantity,
          unitPrice: D(item.unitPrice),
          taxAmount: new Prisma.Decimal(0),
          total: D(item.total),
          originSystem: OriginSystem.DELIVERY_PLATFORM,
        },
        select: { id: true, productId: true, quantity: true },
      })
      for (const m of item.modifiers ?? []) {
        await tx.orderItemModifier.create({
          data: { orderItemId: li.id, modifierId: null, name: m.name, quantity: m.quantity, price: D(m.price) },
        })
      }
      creados.push(li)
    }

    if (pagadoExterno.greaterThan(0)) {
      await tx.payment.create({
        data: {
          venueId: ctx.venueId,
          orderId: order.id,
          amount: D(p.externallyPaidSale), // SIN propina: no se cuenta dos veces
          tipAmount: D(p.externallyPaidTip),
          netAmount: D(p.externallyPaidSale),
          feePercentage: new Prisma.Decimal(0),
          feeAmount: new Prisma.Decimal(0),
          method: PaymentMethod.OTHER, // el schema lo exige para tenders custom
          tenderTypeId: tender.id,
          tenderRevision: tender.revision,
          // Avoqado NO deposita este dinero: lo liquida la plataforma.
          fundsFlow: PaymentFundsFlow.EXTERNAL_RECORDED,
          source: PaymentSource.DELIVERY_PLATFORM,
          originSystem: OriginSystem.DELIVERY_PLATFORM,
          externalSource: 'UBER_EATS',
          status: TransactionStatus.COMPLETED,
          splitType: SplitType.FULLPAYMENT,
          processor: 'uber_eats',
          idempotencyKey: `dlv:${externalId}`.slice(0, 64),
        },
      })
    }

    // Inventario: mismo motor durable que el resto de la plataforma. Las líneas
    // sin productId simplemente no descuentan — mejor no mover el almacén que
    // moverlo mal; el hueco queda visible en la orden marcada.
    const conProducto = creados.filter(c => c.productId)
    if (conProducto.length > 0) {
      const posting = await createSalePostingInTx(tx, { venueId: ctx.venueId, orderId: order.id, items: conProducto as any })
      postingState.id = posting?.id ?? null
    }

    return order.id
  })

  // El posting se aplica FUERA de la transacción (patrón del motor): su fallo
  // nunca revierte una venta ya cobrada.
  if (postingState.id) {
    try {
      await applySalePosting(postingState.id, null)
    } catch (error) {
      logger.error('[🔴 UberIngest] posting de inventario falló (no fatal, el sweeper lo retoma)', {
        orderId, error: error instanceof Error ? error.message : 'desconocido',
      })
    }
  }

  if (unresolvedItems > 0) {
    logger.warn('[⚠️ UberIngest] pedido con líneas sin producto resuelto — revisar', { orderId, unresolvedItems })
  }

  return { orderId, alreadyExisted: false, unresolvedItems }
}
