import type { HttpEnvelope } from './http-operation.mobile.service'
import { lockTableOrderScope } from '@/services/shared/tableOrderLock'
import type { AutomaticServiceChargeCapture } from './service-charge.mobile.service'
/**
 * Mobile Order Service
 *
 * Order management for mobile apps (iOS, Android).
 * Creates orders with items for the dual-mode payment flow:
 * - Quick Payment (FastPayment): No order, just amount
 * - Order Payment: Create order first, then pay via TPV
 */

import { createHash } from 'crypto'
import { OrderSource, OrderType, PaymentFundsFlow, PaymentMethod, Prisma } from '@prisma/client'
import type { ContratoDePrecio, OrderStatus, OriginSystem, PaymentStatus, PaymentType } from '@prisma/client'
import socketManager from '../../communication/sockets'
import { SocketEventType } from '../../communication/sockets/types'
import logger from '../../config/logger'
import { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { validateStaffVenue } from '../../utils/staff-venue.util'
import { generateAndStoreReceipt } from '../dashboard/receipt.dashboard.service'
import { resolveTenderForCharge, computeTenderCommission, type ResolvedTenderCharge } from '../dashboard/tenderType.dashboard.service'
// Reuse the SAME helpers the TPV order/fast endpoints use so the mobile cash
// response carries an identical `digitalReceipt` shape — mobile and TPV never
// drift on how the receipt QR (accessKey + receiptUrl + autofactura) is built.
import { mapDigitalReceiptResponse, resolveAutofacturaAvailable, type OrderInventoryWarning } from '../tpv/payment.tpv.service'
import { enqueuePaymentCommissionInTx, enqueuePaymentEffect, enqueueRefundPaymentEffectsInTx } from '../tpv/paymentEffects.service'
import {
  buildItemDiscountRow,
  calculateDiscountPesos,
  filaDeDescuentoDeCuenta,
  validateDiscountActive,
  validateDiscountScopeForItem,
} from '../shared/discount.service'
import { comoJson, nuevoRepartoDeCuenta } from '../shared/repartoDescuento'
import { conservarDescuentoHistorico, revertirDescuentoDelRenglon, sincronizarRepartos } from '../shared/repartoDescuentoTx'
import { applyPromotionToOrder } from '../promotions/promotion.service'
import { assertVenueSalesEnabled } from '../venueSalesGuard'
import { paymentCountsAsDrawerCash } from '../shared/tenderSemantics'
import { turnoAbiertoDelNegocio } from '../shared/turnoDeCaja'
import {
  bloquearVentaParaLiga,
  clienteYaLigadoALaVenta,
  esChoqueDeUnico,
  etiquetaDeReintento,
  motivoDeReintentoDeLiga,
  asegurarCambioDeClienteBajoCandado,
  esVentaYaCobrada,
} from '../shared/ligaDeClienteEnVenta'
import { assertNoLiveTerminalCharge, assertOrderCancellableUnderLock, avisarOrdenCancelada } from '../shared/orderCancelGuard'
import { combinarContratos } from '../fiscal/contratoDePrecio'
import {
  ORDER_LOCK_WAIT_BUDGET,
  claimShiftForCapturedPayment,
  lockExistingOrderForPayment,
  recordPendingPaymentShiftReconciliation,
  resolvePaymentShiftReconciliationEnabled,
  type CapturedPaymentChannel,
} from '../shared/paymentShiftClaim'
// La aritmética canónica del saldo: UNA sola definición de "cuánto se lleva
// pagado y cuánto falta" para los cuatro caminos de cobro. Se extrajo de este
// mismo archivo; volver a llamarla es lo que impide que se separen otra vez.
import { claseDeEstado, computeOrderBalance, impuestoQueSeCobraAparte, summarizeRefunds, type RefundState } from '../shared/orderBalance'
import { rechazarSiEsImportada } from '../shared/ordenImportada'
import { rechazarSiLaCuentaTieneVales } from '../shared/cuentaConVales'
import { desactivarSobresPendientesDeCuentaEnTx, esCuentaDeTarjetasEnTx, rechazarSiEsCuentaDeTarjetas } from '../giftCards/cuentaDeTarjetas'
import {
  activarSobresDeCuentaPagadaEnTx,
  canjearSobresEnTx,
  lockGiftCardsForUpdate,
  revertirCanjeEnTx,
  saldoUsable,
  sobresDelCanje,
  type LockedGiftCard,
} from '../giftCards/giftCardLedger'
import { hashGiftCardCode, normalizeGiftCardCode } from '../giftCards/giftCardCode'
import { GiftCardError } from '../giftCards/giftCardErrors'
import { MAX_SOBRES_POR_CUENTA, formatoPesos } from '../giftCards/giftCardLimits'
import { ensureGiftCardTender, isGiftCardTenderKind, resolveGiftCardTenderForChargeInTx } from '../giftCards/giftCardTender'
import { RECIBO_CANONICO } from '../shared/reciboCanonico'
import { MAX_TERMINAL_PAYMENT_CENTS } from '../shared/inputCaps'
import type { SaleStampOutcome } from '../shared/loyaltyOnLateCustomer'
import {
  CobroYaRegistrado,
  assertIdempotentPaymentOrder,
  cierreAutomaticoPermitido,
  esCobroNuevo,
  reabrirSiRecibeDinero,
  rechazarCobroNuevoSobreCancelada,
  salirSiLaLlaveYaTienePago,
} from '../shared/cuentaCancelada'
import { debeMarcarCocina, assertPreparationAuthoringAccess } from '../kds/kitchenDisplayStations'
import { armarComandasTrasCommit, retirarComandasDeVentaAnulada } from '../kds/kitchenTicketAuthoring.service'
import { parseServiceCourseSnapshot, legacyCourseForSnapshot, type ServiceCourseSnapshot } from '../service-courses/serviceCourseContract'

// MARK: - Types

export interface CreateOrderItemInput {
  serviceCourse?: ServiceCourseSnapshot | null
  externalId?: string | null
  // Product items set productId; custom items (e.g. "Otro importe") set name + unitPrice.
  productId?: string | null
  name?: string | null
  unitPrice?: number | null // cents — only used for custom items
  quantity: number
  notes?: string | null
  modifierIds?: string[]
  /** Item/category-scoped Discount row id, mirroring TPV's `itemDiscountId`
   *  (order.tpv.service.ts). Validated the same way: must exist, belong to
   *  this venue, and be currently active/within its validity window. */
  discountId?: string | null
  /** Venta por peso: kilos pesados (0.001–99.999) — REQUIRED when the product
   *  has soldByWeight=true (quantity must be 1), REJECTED otherwise. The server
   *  computes total = round(product.price × weightQuantity, 2); the client
   *  never dictates the price. Spec: 2026-07-18-venta-por-peso-bascula.md */
  weightQuantity?: number | null
  /**
   * Promoción tocada en el POS. OPCIONAL y sin precios: lleva QUÉ promoción y
   * QUÉ eligió la persona; la aritmética la hace el server (mismo contrato que
   * `items[].promotionRef` del reducer de ADD_ITEMS — deben permanecer iguales,
   * un nombre distinto entre los dos caminos falla en silencio).
   */
  promotionRef?: {
    promotionId: string
    promotionInstanceId: string
    selections: Array<{
      groupId: string
      optionId: string
      serviceCourse?: ServiceCourseSnapshot | null
    }>
  }
}

export interface CreateOrderInput {
  items: CreateOrderItemInput[]
  staffId: string
  orderType?: 'DINE_IN' | 'TAKEOUT' | 'DELIVERY' | 'PICKUP'
  source?: 'AVOQADO_IOS' | 'AVOQADO_ANDROID' | 'TPV' | 'KIOSK' | 'QR' | 'WEB' | 'APP' | 'PHONE' | 'POS'
  tableId?: string | null
  customerId?: string | null
  customerName?: string | null
  customerPhone?: string | null
  specialRequests?: string | null
  discount?: number // cents
  tip?: number // cents
  note?: string | null
  splitType?: string | null
  /** Links the sale to a class/appointment reservation (walk-in flow).
   *  Validated against the venue before use; ignored if it doesn't belong. */
  reservationId?: string | null
  /** Client-generated idempotency key for offline retries. Mirrors the TPV
   *  pattern (order.tpv.service.ts createOrder): a repeated venueId+externalId
   *  returns the existing order instead of creating a duplicate. */
  externalId?: string | null
  /**
   * Premio de cartilla de sellos a aplicar EN LA CREACIÓN.
   *
   * 🔴 Va aquí y no en una segunda llamada porque el punto de venta cobra el total
   * que devuelve el servidor: si el descuento llegara después, quedaría una ventana
   * con la cuenta al total completo y el cliente podría pagar de más.
   *
   * Aditivo y opcional: sin él, el cuerpo y la respuesta quedan idénticos.
   */
  stampRewardId?: string | null
  /**
   * Cuánto descontó la caja por el premio al COBRAR (centavos). Si el servidor no lo
   * aplica o lo aplica por otro monto, queda en la bitácora: pasa al reconectar una
   * venta cobrada sin red, y la cuenta quedaría debiendo la diferencia en silencio.
   */
  stampRewardExpectedDiscount?: number | null
}

export interface CreatedOrderResponse {
  /**
   * Qué pasó con el premio, si venía uno. Ausente cuando no venía.
   *
   * 🔴 Se devuelve aunque NO se haya aplicado: el cajero tiene que poder ver por qué
   * el cliente no recibió su descuento, en vez de descubrirlo cuando reclame.
   */
  stampReward?: StampRewardOnOrderResult
  id: string
  orderNumber: string
  status: string
  paymentStatus: string
  subtotal: number
  taxAmount: number
  discountAmount: number
  total: number
  items: Array<{
    id: string
    productId: string | null
    productName: string | null
    quantity: number
    unitPrice: number
    total: number
    discountAmount: number
    appliedDiscountId: string | null
    /** Ata la línea a la promoción que la creó. null = línea normal. */
    orderPromotionId: string | null
    modifiers: Array<{
      id: string
      name: string
      price: number
    }>
  }>
  /** Promociones vendidas en esta orden — el POS las usa para agrupar sus
   *  líneas y etiquetarlas (p.ej. "Combo del día"). El nombre sale del
   *  SNAPSHOT (lo que se cobró), nunca de la promoción viva, que pudo
   *  editarse después. netCents/discountCents son centavos internos del
   *  contrato — se exponen tal cual, no en pesos. */
  promotions: Array<{
    id: string
    instanceId: string
    name: string
    netCents: number
    discountCents: number
    needsReview: boolean
  }>
  createdAt: Date
}

// MARK: - Helper Functions

function customerDisplayName(customer: {
  firstName?: string | null
  lastName?: string | null
  email?: string | null
  phone?: string | null
}): string | null {
  const fullName = `${customer.firstName || ''} ${customer.lastName || ''}`.trim()
  return fullName || customer.email || customer.phone || null
}

/**
 * Helper function to flatten OrderItemModifier structure for mobile compatibility
 */
function flattenOrderModifiers(order: any): any {
  if (!order) return order

  return {
    ...order,
    items:
      order.items?.map((item: any) => ({
        ...item,
        modifiers:
          item.modifiers?.map((om: any) => ({
            id: om.modifier?.id || om.id,
            name: om.modifier?.name || om.name,
            price: Number(om.modifier?.price || om.price || 0),
          })) || [],
      })) || [],
  }
}

// MARK: - List Orders Types

export interface ListOrdersInput {
  page: number
  pageSize: number
  search?: string
  status?: string // comma-separated: "COMPLETED,CONFIRMED"
  paymentStatus?: string
}

export interface OrderSummaryResponse {
  id: string
  orderNumber: string
  status: string
  paymentStatus: string
  type: string
  source: string
  subtotal: number
  taxAmount: number
  discountAmount: number
  total: number
  itemCount: number
  staffName: string | null
  customerName: string | null
  createdAt: Date
  /**
   * ADITIVO — el carril del reembolso (founder, 2026-08-18). Una venta devuelta
   * queda CERRADA y MARCADA: el saldo ya no se reabre, así que sin esto se ve
   * idéntica a una cobrada. Espejo de `Payment.refundStatus` de Toast.
   */
  refundState: RefundState
  /** Lo devuelto, en PESOS y POSITIVO. 0 cuando no hay reembolsos. */
  refundedAmount: number
}

export interface OrderDetailResponse {
  id: string
  orderNumber: string
  status: string
  paymentStatus: string
  type: string
  source: string
  subtotal: number
  taxAmount: number
  /** IVA que la orden SUMA aparte (IVA por producto, plan 7, r2 R2-13). 0 = el precio ya lo traía. */
  addedTaxAmount: number
  discountAmount: number
  tipAmount: number
  total: number
  /** Aditivo: saldo canónico para precuenta, en CENTAVOS enteros; no reemplaza los importes legacy en pesos. */
  preBillBalance?: {
    orderTotalCents: number
    totalPaidCents: number
    remainingBalanceCents: number
    tipAmountCents: number
  }
  staffName: string | null
  /** Additive: dueño del cheque (servedById) — el POS lo compara contra su
   *  staffId para pintar read-only cuando enforceTableOwnership está encendido. */
  waiter: { id: string; name: string } | null
  customerName: string | null
  /** Attached customer (Cliente tab) — needed to read their loyalty balance. */
  customerId: string | null
  specialRequests: string | null
  /** TABLE_SERVICE: comensales — editable from the check panel. */
  covers: number | null
  /** Cumplimiento: DINE_IN | TAKEOUT | DELIVERY | PICKUP. */
  orderType: string
  /** Applied ORDER-level discounts (check panel Descuentos). */
  discounts: Array<{ id: string; name: string; amount: number }>
  /** Cobros por servicio aplicados — SUMAN al total (ingreso gravable). */
  serviceChargeAmount: number
  serviceCharges: Array<{ id: string; serviceChargeId: string | null; name: string; amount: number; isAutomatic: boolean }>
  /** Optimistic concurrency del add-round: el POS refresca su sesión con esto. */
  version: number
  createdAt: Date
  items: Array<{
    id: string
    productId: string | null
    productName: string | null
    quantity: number
    unitPrice: number
    total: number
    /** Venta por peso: kilos pesados (unitPrice = precio por kg). Null on normal lines. */
    weightQuantity: number | null
    notes: string | null
    modifiers: Array<{
      id: string
      name: string
      price: number
    }>
    /** TABLE_SERVICE: course/tiempo and send time — the check panel groups sent
     *  items by course and labels each group "Enviado a la cocina a las HH:MM"
     *  (createdAt == fire time in the table flow). */
    course: string | null
    serviceCourse?: { id: string; label: string; kind: 'IMMEDIATE' | 'STANDARD' } | null
    orderPromotionId?: string | null
    externalId?: string | null
    /** TABLE_SERVICE: asiento/comensal de la línea. */
    seat: number | null
    createdAt: Date
    isCortesia: boolean
    cortesiaReason: string | null
  }>
  payments: Array<{
    id: string
    amount: number
    tipAmount: number
    method: string
    status: string
    createdAt: Date
    processedBy: string | null
  }>
  /**
   * Promociones vendidas en esta cuenta — ADITIVO (2026-08-18).
   *
   * El nombre del combo no es opcional en ningún POS del mercado: Fudo imprime
   * "el nombre del combo y, debajo, cada producto asociado"; Square marca el
   * refresco como "part of the Burger Combo"; Maitre'D lo lleva a "reports,
   * order screen, guest checks and receipts". El detalle de la cuenta sólo
   * mostraba un descuento anónimo aunque el dato ya estaba guardado.
   *
   * El nombre sale del SNAPSHOT (lo que se cobró), nunca de la promoción viva.
   * `itemIds` deja al POS anidar las líneas bajo el nombre del combo.
   *
   * 🔴 Centavos, NO pesos: mismo contrato que `CreatedOrderResponse.promotions`,
   * que Android e iOS ya parsean. Dos formas para el mismo objeto en el mismo
   * namespace sería peor que la inconsistencia con el resto de los campos.
   */
  promotions: Array<{
    id: string
    instanceId: string
    name: string
    type: string | null
    pricingMode: string | null
    grossCents: number
    discountCents: number
    netCents: number
    needsReview: boolean
    itemIds: string[]
  }>
  /**
   * ADITIVO — el carril del reembolso (founder, 2026-08-18). Tras un reembolso
   * la cuenta queda CERRADA (`status COMPLETED`, `paymentStatus PAID`) y el
   * dinero devuelto vive AQUÍ, nunca restando del saldo. Es lo que permite
   * pintar "Reembolsada" / "Reembolso parcial $X" y ocultar "cobrar saldo" —
   * espejo de `Payment.refundStatus` de Toast y de `refunded_money` de Square.
   */
  refundState: RefundState
  /** Lo devuelto, en PESOS y POSITIVO (como el resto de importes de esta respuesta). */
  refundedAmount: number
}

// MARK: - Service Functions

/**
 * List orders for a venue with pagination, search, and filters
 *
 * @param venueId Venue ID (tenant isolation)
 * @param input Pagination and filter parameters
 * @returns Paginated list of order summaries
 */
export async function listOrders(venueId: string, input: ListOrdersInput) {
  logger.info(`📱 [ORDER.MOBILE] Listing orders | venue=${venueId} | page=${input.page} | search=${input.search || 'none'}`)

  const skip = (input.page - 1) * input.pageSize
  const take = input.pageSize

  // Build where clause
  const where: any = {
    venueId,
    status: { not: 'DELETED' },
  }

  // Filter by status if provided
  if (input.status) {
    const statuses = input.status.split(',').map(s => s.trim())
    where.status = { in: statuses }
  }

  // Filter by payment status if provided
  if (input.paymentStatus) {
    const paymentStatuses = input.paymentStatus.split(',').map(s => s.trim())
    where.paymentStatus = { in: paymentStatuses }
  }

  // Search by order number
  if (input.search) {
    where.orderNumber = { contains: input.search, mode: 'insensitive' }
  }

  const [orders, total] = await prisma.$transaction([
    prisma.order.findMany({
      where,
      include: {
        servedBy: {
          select: { firstName: true, lastName: true },
        },
        _count: {
          select: { items: true },
        },
        // ADITIVO — sólo para el carril del reembolso. Se acota a los COMPLETED
        // y a tres columnas: en una lista paginada, traer el pago entero sería
        // pagar por dato que nadie pinta. El array NO sale en la respuesta.
        payments: {
          where: { status: 'COMPLETED' },
          select: { amount: true, tipAmount: true, type: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.order.count({ where }),
  ])

  const data: OrderSummaryResponse[] = orders.map((order: any) => {
    // Mismo resumen que usan los cuatro canales de cobro: una sola definición de
    // "cuánto se devolvió" para que la lista no pueda contradecir al detalle.
    const refunds = summarizeRefunds(order.payments ?? [])
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      paymentStatus: order.paymentStatus,
      type: order.type,
      source: order.source,
      subtotal: Number(order.subtotal),
      taxAmount: Number(order.taxAmount),
      discountAmount: Number(order.discountAmount),
      total: Number(order.total),
      itemCount: order._count.items,
      staffName: order.servedBy ? `${order.servedBy.firstName} ${order.servedBy.lastName}`.trim() : null,
      customerName: order.customerName,
      createdAt: order.createdAt,
      refundState: refunds.refundState,
      refundedAmount: Number(refunds.refundedAmount),
    }
  })

  logger.info(`✅ [ORDER.MOBILE] Listed ${data.length} orders (total: ${total})`)

  return {
    data,
    meta: {
      total,
      page: input.page,
      pageSize: input.pageSize,
      pageCount: Math.ceil(total / input.pageSize),
    },
  }
}

/** Include needed to build a CreatedOrderResponse from an Order row. */
const createdOrderInclude = {
  items: {
    include: {
      product: {
        select: {
          id: true,
          name: true,
          price: true,
        },
      },
      modifiers: {
        include: {
          modifier: true,
        },
      },
    },
  },
  // Las promociones vendidas en esta orden. El POS las usa para agrupar sus
  // líneas y etiquetarlas; el nombre sale del SNAPSHOT (lo que se cobró), no
  // de la promoción viva, que pudo editarse después.
  promotions: { select: { id: true, instanceId: true, snapshotJson: true, netCents: true, discountCents: true, needsReview: true } },
} as const

function toCreatedOrderResponse(order: any): CreatedOrderResponse {
  const flattenedOrder = flattenOrderModifiers(order)
  return {
    id: flattenedOrder.id,
    orderNumber: flattenedOrder.orderNumber,
    status: flattenedOrder.status,
    paymentStatus: flattenedOrder.paymentStatus,
    subtotal: Number(flattenedOrder.subtotal),
    taxAmount: Number(flattenedOrder.taxAmount),
    discountAmount: Number(flattenedOrder.discountAmount),
    total: Number(flattenedOrder.total),
    items: flattenedOrder.items.map((item: any) => ({
      id: item.id,
      productId: item.productId,
      productName: item.productName || item.product?.name,
      quantity: item.quantity,
      unitPrice: Number(item.unitPrice),
      total: Number(item.total),
      discountAmount: Number(item.discountAmount || 0),
      appliedDiscountId: item.appliedDiscountId || null,
      /** Ata la línea a la promoción que la creó. null = línea normal. */
      orderPromotionId: item.orderPromotionId ?? null,
      modifiers: item.modifiers || [],
    })),
    promotions: (flattenedOrder.promotions ?? []).map((p: any) => ({
      id: p.id,
      instanceId: p.instanceId,
      name: (p.snapshotJson as any)?.name ?? '',
      netCents: p.netCents,
      discountCents: p.discountCents,
      needsReview: p.needsReview,
    })),
    createdAt: flattenedOrder.createdAt,
  }
}

function normalizeExternalId(externalId?: string | null): string | null {
  if (!externalId) return null
  const trimmed = externalId.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Construye las filas de `OrderItem` de una lista de items del cliente, con TODA la
 * aritmética de dinero: precio del producto, modificadores, venta por peso
 * (cuantizada a 3 decimales ANTES del redondeo a centavos) y descuentos por línea.
 *
 * 🔴 EXTRAÍDO PARA COMPARTIR, NO PARA REESCRIBIR. `createOrderWithItems` y los vales
 * por área (`areaTicket.mobile.service.ts`) DEBEN producir importes idénticos al
 * centavo: el cliente de Culiacán migra desde un sistema cuyos totales ya cuadran con
 * los nuestros (0.224 × 164.00 → 36.74), y dos implementaciones paralelas divergen
 * en cuanto alguien toque una. Una sola función, un solo redondeo.
 *
 * @param fulfillmentAreaId área que estampa cada línea (vales por área §5.3). Lo
 *   resuelve el SERVER desde `Terminal.fulfillmentAreaId`; `null`/undefined deja las
 *   líneas sin área ("se entrega en la caja, al momento"), que es el caso de todos
 *   los flujos que no son vales.
 */
export async function buildOrderItemsData(
  venueId: string,
  items: CreateOrderItemInput[],
  fulfillmentAreaId?: string | null,
): Promise<{
  itemsData: any[]
  subtotal: number
  itemDiscountTotal: number
  discounts: Array<{ id: string; [key: string]: any }>
  modifierSkus: Record<string, string | null>
}> {
  // Validate items array
  if (!items || items.length === 0) {
    throw new BadRequestError('At least one item is required')
  }

  await assertPreparationAuthoringAccess(venueId, items)

  let subtotal = 0
  let itemDiscountTotal = 0

  const productInputs = items.filter(
    (item): item is CreateOrderItemInput & { productId: string } => typeof item.productId === 'string' && item.productId.length > 0,
  )
  const customInputs = items.filter(item => !item.productId)

  // Fetch products and validate
  const uniqueProductIds = [...new Set(productInputs.map(item => item.productId))]
  const products =
    uniqueProductIds.length > 0
      ? await prisma.product.findMany({
          where: {
            id: { in: uniqueProductIds },
            venueId,
          },
          include: {
            category: {
              select: { name: true },
            },
          },
        })
      : []

  if (products.length !== uniqueProductIds.length) {
    const foundIds = products.map(p => p.id)
    const missingIds = uniqueProductIds.filter(id => !foundIds.includes(id))
    throw new BadRequestError(`Products not found: ${missingIds.join(', ')}`)
  }

  // Fetch all modifiers if any items have modifiers
  const allModifierIds = productInputs.flatMap(item => item.modifierIds || [])
  const modifiers =
    allModifierIds.length > 0
      ? await prisma.modifier.findMany({
          where: {
            id: { in: allModifierIds },
            group: {
              venueId, // Security: Only fetch modifiers that belong to this venue
            },
          },
        })
      : []

  logger.info(`📱 [ORDER.MOBILE] Validated ${products.length} products, ${modifiers.length} modifiers, ${customInputs.length} custom items`)

  // Fetch + validate per-item discounts (mirrors order.tpv.service.ts createOrderWithItems:
  // discount must exist, belong to this venue, and be active/within its validity window +
  // usage cap — see src/services/shared/discount.service.ts). TPV rejects the whole order
  // on any invalid/foreign discountId rather than silently ignoring it; mobile mirrors that.
  const discountIds = [...new Set(items.map(item => item.discountId).filter((id): id is string => !!id))]
  const discounts = discountIds.length
    ? await prisma.discount.findMany({
        where: {
          id: { in: discountIds },
          venueId,
        },
      })
    : []

  if (discounts.length !== discountIds.length) {
    const foundIds = discounts.map(discount => discount.id)
    const missingIds = discountIds.filter(id => !foundIds.includes(id))
    throw new BadRequestError(`Descuento no encontrado o no pertenece a este local: ${missingIds.join(', ')}`)
  }

  discounts.forEach(validateDiscountActive)

  // Calculate totals and prepare items data.
  // NOTE: Prices are treated as tax-inclusive (Mexico: IVA is already in price).
  // taxAmount is stored as 0 on items and order. Tax is not added on top of the price.
  // Item/order totals stay gross; discount reductions live in `discountAmount`
  // (same convention as TPV's Cobrar V1 flow — see order.tpv.service.ts).
  const productItemsData = productInputs.map(item => {
    const serviceCourse = parseServiceCourseSnapshot(item.serviceCourse)
    if (item.externalId != null && (typeof item.externalId !== 'string' || item.externalId.length < 1 || item.externalId.length > 256))
      throw new BadRequestError('Identificador de producto inválido')
    const product = products.find(p => p.id === item.productId)!
    const itemModifierIds = item.modifierIds || []

    // Calculate modifier total
    const modifierTotal = itemModifierIds.reduce((sum, modifierId) => {
      const modifier = modifiers.find(m => m.id === modifierId)
      return sum + (modifier ? Number(modifier.price) : 0)
    }, 0)

    // ─── Venta por peso (soldByWeight) ───────────────────────────────────────
    // Weighted lines carry weightQuantity (kg); the SERVER computes the money:
    // base = round(price/kg × weightKg, 2). quantity must be 1. Weight on a
    // non-weighted product (or missing weight on a weighted one) is a 400 —
    // explicit over silent (spec D4, pregunta 2).
    const rawWeightKg = item.weightQuantity != null ? Number(item.weightQuantity) : null
    if (product.soldByWeight) {
      if (rawWeightKg == null || !Number.isFinite(rawWeightKg) || rawWeightKg <= 0) {
        throw new BadRequestError(`El producto "${product.name}" se vende por peso; envía weightQuantity en kilogramos.`)
      }
      if (rawWeightKg < 0.001 || rawWeightKg > 99.999) {
        throw new BadRequestError(`El peso para "${product.name}" está fuera de rango (0.001–99.999 kg).`)
      }
      if (item.quantity !== 1) {
        throw new BadRequestError(`Las líneas por peso llevan cantidad 1 — cada pesada es una línea (producto "${product.name}").`)
      }
    } else if (rawWeightKg != null) {
      throw new BadRequestError(`El producto "${product.name}" no se vende por peso; no envíes weightQuantity.`)
    }
    // Quantize to the PERSISTED precision (weightQuantity is Decimal(12,3)) BEFORE
    // the money math, so total == round(price × stored weight) always holds — a
    // reprint or a >3-decimal scale reading can't diverge by a cent (review
    // 2026-07-19, fix #3). Mirrors order.tpv.service.ts.
    const weightKg = rawWeightKg != null ? Math.round(rawWeightKg * 1000) / 1000 : null

    // Calculate item total: (product price + modifiers) * quantity.
    // Weighted: base = round(price × weightKg, 2) + modifiers (quantity is 1).
    const lineBase = product.soldByWeight
      ? Math.round(Number(product.price) * weightKg! * 100) / 100
      : Number(product.price) * item.quantity
    const itemTotal = lineBase + modifierTotal * item.quantity
    subtotal += itemTotal

    const appliedDiscount = item.discountId ? discounts.find(discount => discount.id === item.discountId)! : null
    if (appliedDiscount) {
      validateDiscountScopeForItem(appliedDiscount, { productId: product.id, categoryId: product.categoryId })
    }
    const lineDiscount = appliedDiscount ? calculateDiscountPesos(appliedDiscount, itemTotal) : 0
    itemDiscountTotal += lineDiscount

    return {
      productId: item.productId,
      ...(serviceCourse ? { serviceCourse: serviceCourse as Prisma.InputJsonValue, course: legacyCourseForSnapshot(serviceCourse) } : {}),
      ...(item.externalId ? { externalId: item.externalId } : {}),
      productName: product.name,
      productSku: product.sku,
      categoryName: product.category?.name || null,
      quantity: item.quantity,
      unitPrice: new Prisma.Decimal(Number(product.price)),
      weightQuantity: product.soldByWeight ? new Prisma.Decimal(weightKg!) : null,
      weightUnit: product.soldByWeight ? ('KILOGRAM' as const) : null,
      discountAmount: new Prisma.Decimal(lineDiscount),
      appliedDiscountId: appliedDiscount?.id || null,
      taxAmount: new Prisma.Decimal(0),
      total: new Prisma.Decimal(itemTotal),
      notes: item.notes || null,
      fulfillmentAreaId: fulfillmentAreaId || null,
      modifiers: {
        create: itemModifierIds.map(modifierId => {
          const modifier = modifiers.find(m => m.id === modifierId)!
          return {
            modifierId,
            name: modifier.name,
            quantity: 1,
            price: modifier.price,
          }
        }),
      },
    }
  })

  // Custom line items ("Otro importe"): no productId, client-provided name + unitPrice (cents).
  const customItemsData = customInputs.map(item => {
    const unitPrice = (item.unitPrice ?? 0) / 100 // cents -> decimal
    const itemTotal = unitPrice * item.quantity
    subtotal += itemTotal

    const appliedDiscount = item.discountId ? discounts.find(discount => discount.id === item.discountId)! : null
    if (appliedDiscount) {
      validateDiscountScopeForItem(appliedDiscount, { productId: null, categoryId: null })
    }
    const lineDiscount = appliedDiscount ? calculateDiscountPesos(appliedDiscount, itemTotal) : 0
    itemDiscountTotal += lineDiscount

    return {
      productId: null,
      productName: item.name || 'Otro importe',
      productSku: null,
      categoryName: null,
      quantity: item.quantity,
      unitPrice: new Prisma.Decimal(unitPrice),
      discountAmount: new Prisma.Decimal(lineDiscount),
      appliedDiscountId: appliedDiscount?.id || null,
      taxAmount: new Prisma.Decimal(0),
      total: new Prisma.Decimal(itemTotal),
      notes: item.notes || null,
      fulfillmentAreaId: fulfillmentAreaId || null,
    }
  })

  const itemsData = [...productItemsData, ...customItemsData]
  // Caja externa: el SKU de cada extra, para que el vale lo congele SIN meterlo en
  // `modifiers.create` (OrderItemModifier no tiene esa columna y Prisma rechazaría la orden).
  const modifierSkus: Record<string, string | null> = Object.fromEntries(modifiers.map(modifier => [modifier.id, modifier.sku ?? null]))
  return { itemsData, subtotal, itemDiscountTotal, discounts, modifierSkus }
}

/**
 * Create a new order with items (for mobile order-based payment flow)
 *
 * This is called by iOS/Android before initiating payment via BLE to TPV.
 * The TPV will then complete the payment using the orderId.
 *
 * Idempotent when the client sends `externalId` (offline-retry safety): a
 * repeated venueId+externalId returns the existing order — same contract as
 * the TPV's createOrder.
 *
 * @param venueId Venue ID (tenant isolation)
 * @param input Order creation parameters including items
 * @returns Created order with calculated totals
 */
export async function createOrderWithItems(venueId: string, input: CreateOrderInput): Promise<CreatedOrderResponse> {
  logger.info(
    `📱 [ORDER.MOBILE] Creating order with ${input.items.length} items | venue=${venueId} | type=${input.orderType || 'DINE_IN'} | source=${input.source || 'AVOQADO_IOS'}`,
  )
  // Enums del body validados ANTES de tocar la DB: un `source`/`orderType` inventado llegaba a
  // `tx.order.create()` y Prisma reventaba con 500 + ruta absoluta del servicio en el body
  // (hallazgo de /full-testing 2026-08-18). Es un dato inválido del cliente → 400 en español.
  if (input.source && !Object.values(OrderSource).includes(input.source as OrderSource)) {
    throw new BadRequestError(`Origen de la orden inválido: ${String(input.source)}`)
  }
  if (input.orderType && !Object.values(OrderType).includes(input.orderType as OrderType)) {
    throw new BadRequestError(`Tipo de orden inválido: ${String(input.orderType)}`)
  }

  // Idempotency short-circuit BEFORE any validation/creation work: an offline
  // client retrying after a lost response must get the original order back.
  const externalId = normalizeExternalId(input.externalId)
  if (externalId) {
    const existingOrder = await prisma.order.findUnique({
      where: {
        venueId_externalId: {
          venueId,
          externalId,
        },
      },
      include: createdOrderInclude,
    })
    if (existingOrder) {
      logger.warn(`🔄 [ORDER.MOBILE] Duplicate createOrderWithItems detected (externalId=${externalId}) — returning existing order`)
      // 🔴 La caja que reintenta (perdió la respuesta) tiene que saber qué pasó con el premio
      // en el PRIMER intento: sin esto lo leería como «no aplicado» y cobraría el precio
      // completo con el premio ya quemado.
      if (input.stampRewardId) {
        const stampReward = await ensureStampRewardOnExistingOrder(
          venueId,
          existingOrder.id,
          input.stampRewardId,
          input.staffId,
          input.stampRewardExpectedDiscount,
        )
        // Si el reintento lo canjeó AHORA, `existingOrder` se leyó antes del descuento: se relee (la caja cobra esta respuesta).
        const ordenReleida = stampReward.applied
          ? ((await prisma.order.findUnique({ where: { id: existingOrder.id }, include: createdOrderInclude })) ?? existingOrder)
          : existingOrder
        return { ...toCreatedOrderResponse(ordenReleida), stampReward }
      }
      return toCreatedOrderResponse(existingOrder)
    }
  }

  // Una venta tiene que traer ALGO. Lo exigía buildOrderItemsData, que a partir
  // de aquí sólo ve las líneas normales — sin este guard, un body vacío crearía
  // una orden de $0 en vez de rechazarse.
  if (input.items.length === 0) {
    throw new BadRequestError('Se requiere al menos un artículo o una promoción')
  }

  await assertVenueSalesEnabled(venueId)

  const validatedStaffId = await validateStaffVenue(input.staffId, venueId)

  // Los items con `promotionRef` NO pasan por el alta normal: su precio lo
  // resuelve el motor de promociones (espejo exacto de applyAddItems en
  // sync.mobile.service.ts). Un item sin promotionRef se comporta igual que hoy.
  const itemsConPromocion = input.items.filter(it => it.promotionRef)
  const itemsNormales = input.items.filter(it => !it.promotionRef)
  await assertPreparationAuthoringAccess(venueId, itemsConPromocion)

  // Dedupe defensivo por instancia: dos líneas con el mismo instanceId son la
  // MISMA promoción (un doble tap del cajero), no dos combos.
  const promocionesUnicas = [...new Map(itemsConPromocion.map(it => [it.promotionRef!.promotionInstanceId, it.promotionRef!])).values()]

  // 🔴 buildOrderItemsData lanza 'At least one item is required' con lista
  // vacía. Una venta de PURAS promociones (el combo ES la venta) es legítima,
  // así que se salta cuando no hay líneas normales.
  const { itemsData, subtotal, itemDiscountTotal, discounts } =
    itemsNormales.length > 0
      ? await buildOrderItemsData(venueId, itemsNormales)
      : { itemsData: [] as any[], subtotal: 0, itemDiscountTotal: 0, discounts: [] as Array<{ id: string; [key: string]: any }> }

  // Generate order number
  const orderNumber = `ORD-${Date.now()}`

  // Order-level flat discount (input.discount, cents) composes additively with the
  // per-item Discount reductions above — same shape as TPV's `discountAmount =
  // itemDiscountPesos + orderDiscountPesos` (order.tpv.service.ts createOrderWithItems).
  // It's clamped against what's left of the subtotal *after* item discounts so the
  // order can never go negative.
  const remainingAfterItemDiscounts = Math.max(0, subtotal - itemDiscountTotal)
  const orderLevelDiscountDecimal = Math.min(remainingAfterItemDiscounts, Math.max(0, (input.discount || 0) / 100))
  const discountDecimal = itemDiscountTotal + orderLevelDiscountDecimal
  // Tip (cents -> decimal). In Mexico, tip is added on top of the tax-inclusive subtotal.
  const tipDecimal = (input.tip || 0) / 100
  const total = subtotal - discountDecimal + tipDecimal
  const normalizedCustomerId = input.customerId?.trim() || null
  let resolvedCustomerName = input.customerName || null
  let resolvedCustomerPhone = input.customerPhone || null

  if (normalizedCustomerId) {
    const customer = await prisma.customer.findUnique({
      where: { id: normalizedCustomerId },
      select: {
        id: true,
        venueId: true,
        firstName: true,
        lastName: true,
        phone: true,
      },
    })

    if (!customer || customer.venueId !== venueId) {
      throw new NotFoundError('Customer not found')
    }

    if (!resolvedCustomerName) {
      const fullName = `${customer.firstName || ''} ${customer.lastName || ''}`.trim()
      resolvedCustomerName = fullName.length > 0 ? fullName : null
    }
    if (!resolvedCustomerPhone) {
      resolvedCustomerPhone = customer.phone || null
    }
  }

  // Validate the optional reservation link belongs to this venue. We never
  // fail the sale over a bad link (a bogus id would also break the FK insert),
  // so an unknown/foreign reservationId is simply dropped with a warning.
  let linkedReservationId: string | null = null
  if (input.reservationId) {
    const reservation = await prisma.reservation.findFirst({
      where: { id: input.reservationId, venueId },
      select: { id: true },
    })
    if (reservation) {
      linkedReservationId = reservation.id
    } else {
      logger.warn(
        `[createOrderWithItems] reservationId ${input.reservationId} not found in venue ${venueId}; order created without reservation link`,
      )
    }
  }

  // Create order with items, and any item-discount `OrderDiscount` audit rows,
  // in a single transaction (matches TPV's transactional boundary —
  // order.tpv.service.ts createOrderWithItems writes its OrderDiscount rows
  // inside the same tx as the order/orderItem creation).
  //
  // 🔴 Y las promociones de la venta, con la reafirmación de su dinero, van en ESA MISMA transacción (Plan3b, fallo
  // T4-R1). La orden es privada hasta el commit: nadie —ni la captura fiscal, ni un cobro, ni un reintento con el mismo
  // externalId— puede verla sin su combo, y si una promoción truena se revierte la venta ENTERA: no queda cuenta a
  // medias que anular ni llave de idempotencia envenenada, así que el reintento del POS la crea normal.
  let order
  let promotionTotals: { subtotal: number; discount: number; total: number } | null = null
  try {
    const created = await prisma.$transaction(async tx => {
      if (input.tableId) await lockTableOrderScope(tx, { venueId, orderIds: [], tableIds: [input.tableId] })
      // 🔴 La venta se toma en el mostrador: la orden nace en el turno de caja abierto AHORA
      // (`../shared/turnoDeCaja.ts`), resuelto con el MISMO cliente de la transacción — pasar
      // `prisma` aquí se saldría de ella. Desde la fase 1, `getActiveShifts` cuenta las órdenes
      // del turno agrupando por `Order.shiftId`. Opcional: sin turno abierto la venta ocurre igual.
      const currentShift = await turnoAbiertoDelNegocio(tx, venueId)

      const createdOrder = await tx.order.create({
        data: {
          venueId,
          shiftId: currentShift?.id ?? null,
          orderNumber,
          externalId,
          reservationId: linkedReservationId,
          tableId: input.tableId || null,
          servedById: validatedStaffId || null,
          createdById: validatedStaffId || null,
          status: 'CONFIRMED',
          paymentStatus: 'PENDING',
          kitchenStatus: 'PENDING',
          type: input.orderType || 'DINE_IN',
          source: input.source || 'AVOQADO_IOS',
          customerId: normalizedCustomerId,
          subtotal: new Prisma.Decimal(subtotal),
          discountAmount: new Prisma.Decimal(discountDecimal),
          taxAmount: new Prisma.Decimal(0),
          contratoDePrecio: 'IVA_INCLUIDO',
          tipAmount: new Prisma.Decimal(tipDecimal),
          total: new Prisma.Decimal(total),
          remainingBalance: new Prisma.Decimal(total),
          customerName: resolvedCustomerName,
          customerPhone: resolvedCustomerPhone,
          specialRequests: input.note || input.specialRequests || null,
          version: 1,
          orderCustomers: normalizedCustomerId
            ? {
                create: [
                  {
                    customerId: normalizedCustomerId,
                    isPrimary: true,
                  },
                ],
              }
            : undefined,
          items: {
            create: itemsData,
          },
        },
        include: createdOrderInclude,
      })

      // Write OrderDiscount audit rows for item discounts — mirrors TPV
      // (order.tpv.service.ts) so dashboard discount-breakdown reporting,
      // which reads OrderDiscount, also reflects mobile-applied item
      // discounts. One row per discounted item (same shape as TPV).
      const discountedItems = createdOrder.items.filter((item: any) => item.appliedDiscountId)
      const appliedByStaffVenue =
        validatedStaffId && (discountedItems.length > 0 || (input.discount ?? 0) > 0)
          ? await tx.staffVenue.findFirst({
              where: { staffId: validatedStaffId, venueId },
              select: { id: true },
            })
          : null
      for (const item of discountedItems) {
        const discount = discounts.find(d => d.id === item.appliedDiscountId)
        if (!discount) continue
        await tx.orderDiscount.create({
          data: buildItemDiscountRow({
            orderId: createdOrder.id,
            itemId: item.id,
            discount,
            discountAmountPesos: Number(item.discountAmount),
            appliedById: appliedByStaffVenue?.id || null,
          }),
        })
      }

      if (promocionesUnicas.length === 0) {
        // B2 (founder, 27-sep): el descuento de CUENTA es su propia fila; la cabecera ya lo trae (`discountDecimal`).
        if (orderLevelDiscountDecimal > 0) {
          await tx.orderDiscount.create({
            data: filaDeDescuentoDeCuenta({
              orderId: createdOrder.id,
              montoPesos: orderLevelDiscountDecimal,
              appliedById: appliedByStaffVenue?.id ?? null,
            }),
          })
          await sincronizarRepartos(tx, createdOrder.id)
        }
        return { order: createdOrder, promotionTotals: null }
      }

      // Mismo servicio que usa el reducer offline (applyAddItems), con ESTA transacción: crea sus líneas, reparte el
      // descuento al centavo y recalcula los totales de la orden sin abrir otra transacción. Todo-o-nada: si la #2
      // truena, la #1 se va con el rollback de la venta.
      for (const ref of promocionesUnicas) {
        const preparationOptions: [options?: { componentExternalIdPrefix: string }] = ref.selections.some(
          s => s.serviceCourse?.preparationVersion === 1,
        )
          ? [{ componentExternalIdPrefix: `combo:${ref.promotionInstanceId}` }]
          : []
        await applyPromotionToOrder(
          {
            venueId,
            orderId: createdOrder.id,
            promotionId: ref.promotionId,
            instanceId: ref.promotionInstanceId,
            selections: ref.selections,
            // Venta EN LÍNEA: el instante es ahora. El acotado de reloj
            // (clampSoldAt) es del camino offline, donde el cliente propone la hora.
            soldAt: new Date(),
          },
          tx,
          ...preparationOptions,
        )
      }

      // 🔴 DINERO. `applyPromotionToOrder` recalcula los totales con
      // `recalculateOrderTotals`, que es COMPARTIDO y sólo sabe de líneas,
      // OrderDiscount y cargos por servicio. Ignora dos términos que son propios
      // de ESTE endpoint, y al sobrescribir `total`/`remainingBalance` los borra:
      //
      //   a) la PROPINA (`input.tip`): no existe en esa función, así que el total
      //      quedaba corto por la propina — la orden se cerraba PAGADA con una
      //      propina que nadie cobró, y el corte no cuadraba.
      //   b) el descuento de ORDEN (`input.discount`): sólo se respeta cuando NO
      //      hay filas OrderDiscount (su fallback). Con un descuento de artículo
      //      presente hay filas, el fallback no aplica y el descuento de orden se
      //      perdía — cobrándole de MÁS al cliente.
      //
      // Aquí se reafirman los términos que este endpoint sí conoce, releídos en la MISMA transacción. No se toca la
      // función compartida (la usan comp/split/descuentos), y una venta SIN promociones nunca pasa por aquí: sigue
      // comportándose igual que siempre.
      const recalculada = await tx.order.findFirst({
        where: { id: createdOrder.id, venueId },
        select: { subtotal: true, serviceChargeAmount: true, paidAmount: true },
      })
      if (!recalculada) {
        throw new NotFoundError('No encontramos esa cuenta en este establecimiento.')
      }
      // El subtotal SÍ es autoridad del motor (ya trae las líneas del combo).
      const subtotalConPromociones = Number(recalculada.subtotal)
      const serviceChargeAmount = Number(recalculada.serviceChargeAmount ?? 0)

      // 🔴 El tope del descuento de ORDEN se recalcula contra el subtotal CON
      // promociones. Al crear la orden el combo todavía no existía —en una venta
      // de puras promociones el subtotal era 0—, así que el descuento del cajero
      // se capaba al valor de los artículos sueltos, o desaparecía COMPLETO sin
      // error y sin rastro. Nunca cobraba de menos: cobraba de MÁS que lo que el
      // cajero aplicó.
      const topeDescuentoDeOrden = Math.max(0, subtotalConPromociones - itemDiscountTotal)
      const descuentoDeOrdenFinal = Math.min(topeDescuentoDeOrden, Math.max(0, (input.discount || 0) / 100))
      const descuentoFinal = itemDiscountTotal + descuentoDeOrdenFinal

      const totalFinal = Math.round((Math.max(0, subtotalConPromociones - descuentoFinal) + serviceChargeAmount + tipDecimal) * 100) / 100
      const remainingFinal = Math.round(Math.max(0, totalFinal - Number(recalculada.paidAmount ?? 0)) * 100) / 100
      // B2: la fila nace aquí, con el importe reafirmado contra el subtotal CON promociones, y se sincroniza sobre el combo.
      if (descuentoDeOrdenFinal > 0) {
        await tx.orderDiscount.create({
          data: filaDeDescuentoDeCuenta({
            orderId: createdOrder.id,
            montoPesos: descuentoDeOrdenFinal,
            appliedById: appliedByStaffVenue?.id ?? null,
          }),
        })
        await sincronizarRepartos(tx, createdOrder.id)
      }
      const reafirmada = await tx.order.update({
        where: { id: createdOrder.id },
        data: {
          discountAmount: new Prisma.Decimal(descuentoFinal),
          total: new Prisma.Decimal(totalFinal),
          remainingBalance: new Prisma.Decimal(remainingFinal),
          version: { increment: 1 },
        },
        include: createdOrderInclude,
      })
      return {
        order: reafirmada,
        promotionTotals: { subtotal: subtotalConPromociones, discount: descuentoFinal, total: totalFinal },
      }
    }, ORDER_LOCK_WAIT_BUDGET)
    order = created.order
    promotionTotals = created.promotionTotals
  } catch (error) {
    // Concurrent-retry race: two identical offline retries can both pass the
    // pre-check; the unique index (venueId, externalId) blocks the loser —
    // return the winner instead of failing the retry. Mirrors recordFastPayment.
    if (externalId && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const winner = await prisma.order.findUnique({
        where: {
          venueId_externalId: {
            venueId,
            externalId,
          },
        },
        include: createdOrderInclude,
      })
      if (winner) {
        logger.warn(`🛡️ [ORDER.MOBILE] Concurrent duplicate blocked by unique index (externalId=${externalId}) — returning winner`)
        // 🔴 El perdedor de la carrera también tiene que decir qué pasó con el premio: sin esto la
        // caja lo leería como «no aplicado» y cobraría completo con el premio ya quemado.
        if (input.stampRewardId) {
          const stampReward = await ensureStampRewardOnExistingOrder(
            venueId,
            winner.id,
            input.stampRewardId,
            input.staffId,
            input.stampRewardExpectedDiscount,
          )
          // Si el reintento lo canjeó AHORA, `winner` se leyó antes del descuento: se relee (la caja cobra esta respuesta).
          const ordenReleida = stampReward.applied
            ? ((await prisma.order.findUnique({ where: { id: winner.id }, include: createdOrderInclude })) ?? winner)
            : winner
          return { ...toCreatedOrderResponse(ordenReleida), stampReward }
        }
        return toCreatedOrderResponse(winner)
      }
    }
    throw error
  }

  logger.info(
    `✅ [ORDER.MOBILE] Order created | id=${order.id} | number=${order.orderNumber} | subtotal=${subtotal} | discount=${discountDecimal} | tip=${tipDecimal} | total=${total}`,
  )

  // Bump usage counters for any Discount rows applied via item.discountId (mirrors
  // order.tpv.service.ts). Best-effort: the order already committed above, so a
  // failure here must not fail the request — it would only leave a discount's
  // maxTotalUses counter stale, not corrupt the order/payment.
  if (discounts.length > 0) {
    try {
      await prisma.discount.updateMany({
        where: { id: { in: discounts.map(discount => discount.id) } },
        data: { currentUses: { increment: 1 } },
      })
    } catch (error) {
      logger.error('❌ [ORDER.MOBILE] Failed to increment discount currentUses', {
        orderId: order.id,
        discountIds: discounts.map(discount => discount.id),
        error: (error as Error).message,
      })
    }
  }

  if (promotionTotals) {
    logger.info(
      `🎁 [ORDER.MOBILE] ${promocionesUnicas.length} promoción(es) aplicadas | order=${order.id} | subtotal=${promotionTotals.subtotal} | descuento=${promotionTotals.discount} | propina=${tipDecimal} | total=${promotionTotals.total}`,
    )
  }

  // 🔴 El premio se aplica AQUÍ, con la orden ya creada y antes de devolverla: el
  // punto de venta cobra el total que sale de esta respuesta.
  const stampReward = await applyStampRewardToNewOrder(
    venueId,
    order.id,
    input.stampRewardId,
    input.staffId,
    input.stampRewardExpectedDiscount,
  )

  // 🔴 Y si se aplicó, hay que RELEER. `order` es el objeto en memoria de antes del
  // descuento; devolverlo tal cual haría que el aparato cobre el total sin descontar
  // — el premio quemado y el cliente pagando completo, que es la peor combinación.
  const orderFinal = stampReward.applied
    ? ((await prisma.order.findUnique({ where: { id: order.id }, include: createdOrderInclude })) ?? order)
    : order

  // Emit Socket.IO event for real-time order creation
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastToVenue(venueId, SocketEventType.ORDER_CREATED, {
      orderId: order.id,
      orderNumber: order.orderNumber,
      orderType: order.type,
      source: order.source,
      total: Number(orderFinal.total),
    })
  }

  // Flatten and return response
  return { ...toCreatedOrderResponse(orderFinal as typeof order), ...(input.stampRewardId ? { stampReward } : {}) }
}

/**
 * Get order details by ID
 *
 * @param venueId Venue ID (tenant isolation)
 * @param orderId Order ID
 * @returns Order with items and payment status
 */
export async function getOrder(venueId: string, orderId: string): Promise<OrderDetailResponse> {
  logger.info(`📱 [ORDER.MOBILE] Getting order ${orderId} | venue=${venueId}`)

  const order = await prisma.order.findUnique({
    where: {
      id: orderId,
      venueId,
    },
    include: {
      servedBy: {
        select: { firstName: true, lastName: true },
      },
      serviceCharges: true,
      items: {
        include: {
          product: {
            select: {
              id: true,
              name: true,
              price: true,
            },
          },
          modifiers: {
            include: {
              modifier: true,
            },
          },
        },
        orderBy: {
          createdAt: 'asc',
        },
      },
      payments: {
        select: {
          id: true,
          amount: true,
          tipAmount: true,
          method: true,
          status: true,
          createdAt: true,
          // ADITIVO: sin `type` un reembolso es indistinguible de un cobro
          // negativo. NO se serializa en `payments[]` (contrato viejo intacto);
          // alimenta `refundState`/`refundedAmount` y el saldo aditivo de precuenta.
          type: true,
          processedBy: {
            select: { firstName: true, lastName: true },
          },
        },
      },
      orderDiscounts: {
        select: { id: true, name: true, amount: true },
      },
      // Promociones vendidas en la cuenta — el POS agrupa sus líneas bajo el
      // nombre del combo tal como se cobró (snapshot), no el nombre vivo.
      promotions: {
        select: {
          id: true,
          instanceId: true,
          snapshotJson: true,
          grossCents: true,
          discountCents: true,
          netCents: true,
          needsReview: true,
          items: { select: { id: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  // Flatten modifiers for mobile response
  const flattenedOrder = flattenOrderModifiers(order)

  // Sólo dinero ocurrido: COMPLETED, incluido `type` para que REFUND no reabra deuda.
  // El calculador compartido suma la propina al total y al pagado; no se resta de la mercancía.
  // Proyección pura de lo ya leído: sin otra consulta ni cambios a los importes legacy.
  const balance = computeOrderBalance(
    flattenedOrder,
    (flattenedOrder.payments || []).filter((p: any) => p.status === 'COMPLETED'),
  )

  return {
    id: flattenedOrder.id,
    orderNumber: flattenedOrder.orderNumber,
    status: flattenedOrder.status,
    paymentStatus: flattenedOrder.paymentStatus,
    type: flattenedOrder.type,
    source: flattenedOrder.source,
    subtotal: Number(flattenedOrder.subtotal),
    taxAmount: Number(flattenedOrder.taxAmount),
    // Aditivo (IVA por producto, plan 7, r2 R2-13): el IVA que la orden de verdad suma aparte (0 con IVA_INCLUIDO o cancelada).
    addedTaxAmount: impuestoQueSeCobraAparte(flattenedOrder).toNumber(),
    discountAmount: Number(flattenedOrder.discountAmount),
    tipAmount: Number(flattenedOrder.tipAmount),
    total: Number(flattenedOrder.total),
    preBillBalance: {
      orderTotalCents: pesosToCents(balance.total.toNumber()),
      totalPaidCents: pesosToCents(balance.paidAmount.toNumber()),
      remainingBalanceCents: pesosToCents(balance.remainingBalance.toNumber()),
      tipAmountCents: pesosToCents(balance.tipAmount.toNumber()),
    },
    staffName: flattenedOrder.servedBy ? `${flattenedOrder.servedBy.firstName} ${flattenedOrder.servedBy.lastName}`.trim() : null,
    // Additive: dueño del cheque con id — para la UI read-only de propiedad de mesa.
    waiter: flattenedOrder.servedById
      ? {
          id: flattenedOrder.servedById,
          name: flattenedOrder.servedBy ? `${flattenedOrder.servedBy.firstName} ${flattenedOrder.servedBy.lastName}`.trim() : '',
        }
      : null,
    customerName: flattenedOrder.customerName,
    // The ATTACHED customer (Cliente tab). Additive: the POS needs it to read
    // that customer's loyalty balance for "Recompensas".
    customerId: flattenedOrder.customerId ?? null,
    specialRequests: flattenedOrder.specialRequests,
    covers: flattenedOrder.covers ?? null,
    orderType: flattenedOrder.type,
    // Applied ORDER-level discounts, for the check panel's Descuentos list.
    discounts: (flattenedOrder.orderDiscounts || []).map((d: any) => ({
      id: d.id,
      name: d.name,
      amount: Number(d.amount),
    })),
    serviceChargeAmount: Number(flattenedOrder.serviceChargeAmount ?? 0),
    serviceCharges: (flattenedOrder.serviceCharges || []).map((sc: any) => ({
      id: sc.id,
      serviceChargeId: sc.serviceChargeId ?? null,
      name: sc.name,
      amount: Number(sc.amount),
      isAutomatic: sc.isAutomatic,
    })),
    // Cada mutación del panel incrementa Order.version: exponerla deja al POS
    // refrescar su sesión y evita el 409 fantasma al Enviar (auditoría).
    version: flattenedOrder.version,
    createdAt: flattenedOrder.createdAt,
    items: flattenedOrder.items.map((item: any) => ({
      id: item.id,
      productId: item.productId,
      productName: item.productName || item.product?.name,
      quantity: item.quantity,
      unitPrice: Number(item.unitPrice),
      total: Number(item.total),
      // Venta por peso: kilos pesados (unitPrice = precio por kg) — the POS
      // check panel / reprint shows "0.435 kg × $420.00/kg". Null on normal lines.
      weightQuantity: item.weightQuantity != null ? Number(item.weightQuantity) : null,
      notes: item.notes || null,
      modifiers: item.modifiers || [],
      // TABLE_SERVICE check panel (modelo Square): el POS agrupa los enviados
      // por RONDA — (course, sentToKitchenAt) — con encabezado repetible
      // "tiempo · Enviado a la cocina a las HH:MM". sentToKitchenAt lo estampa
      // addItemsToOrder en modo ronda; filas viejas (pre-cambio) lo traen null
      // y el cliente cae a createdAt.
      course: item.course ?? null,
      serviceCourse: item.serviceCourse as { id: string; label: string; kind: 'IMMEDIATE' | 'STANDARD' } | null,
      orderPromotionId: item.orderPromotionId ?? null,
      externalId: item.externalId ?? null,
      seat: item.seat ?? null,
      createdAt: item.createdAt,
      sentToKitchenAt: item.sentToKitchenAt ?? null,
      isCortesia: item.isCortesia ?? false,
      cortesiaReason: item.cortesiaReason ?? null,
    })),
    payments: (flattenedOrder.payments || []).map((p: any) => ({
      id: p.id,
      amount: Number(p.amount),
      tipAmount: Number(p.tipAmount),
      method: p.method,
      status: p.status,
      createdAt: p.createdAt,
      processedBy: p.processedBy ? `${p.processedBy.firstName} ${p.processedBy.lastName}`.trim() : null,
    })),
    promotions: (flattenedOrder.promotions || []).map((p: any) => {
      const snapshot = (p.snapshotJson ?? {}) as { name?: string; type?: string; pricingMode?: string }
      return {
        id: p.id,
        instanceId: p.instanceId,
        name: snapshot.name ?? 'Promoción',
        type: snapshot.type ?? null,
        pricingMode: snapshot.pricingMode ?? null,
        grossCents: p.grossCents,
        discountCents: p.discountCents,
        netCents: p.netCents,
        needsReview: p.needsReview,
        itemIds: (p.items ?? []).map((i: any) => i.id),
      }
    }),
    refundState: balance.refundState,
    refundedAmount: Number(balance.refundedAmount),
  }
}

// MARK: - Order details (check panel: nombre/notas/comensales/cliente)

export interface OrderDetailsInput {
  /** Check display name (Square "Nombre") → Order.customerName. */
  name?: string | null
  /** Check notes (Square "Notas") → Order.specialRequests. */
  notes?: string | null
  /** Covers/comensales (Square "Conteo de clientes"). */
  covers?: number | null
  /** Attach a venue customer (Square's Cliente tab). Empty string detaches. */
  customerId?: string | null
  /** Cumplimiento (Square): DINE_IN | TAKEOUT | DELIVERY | PICKUP. */
  orderType?: string | null
}

export interface OpcionesDeDetalleDeCuenta {
  /**
   * 🔴 R4-2 (ronda 4 post-QA de sellos tardíos): ¿quien edita tiene `payments:create`? Lo resuelven el controller (resolvedor
   * efectivo), el reducer offline (`authorizeIntent`) y el MCP (`guard.tienePermiso`). Sin él, en una venta COBRADA no se cambia
   * el cliente (403). Sin decirlo, falla CERRADO.
   */
  puedeCambiarClienteEnVentaCobrada?: boolean
}

/**
 * TABLE_SERVICE — partial update of the check's details. Only provided keys
 * change; covers also synchronizes automatic service charges atomically.
 */
export async function updateOrderDetailsInTransaction(
  tx: Prisma.TransactionClient,
  venueId: string,
  orderId: string,
  input: OrderDetailsInput,
  opciones: OpcionesDeDetalleDeCuenta = {},
) {
  if (!(await lockExistingOrderForPayment(tx, { venueId, orderId }))) throw new NotFoundError('Order not found')
  const charges: AutomaticServiceChargeCapture = { createdIds: [], deletedIds: [], recalculatedIds: [] }
  const order = await tx.order.findFirst({
    where: { id: orderId, venueId },
    select: { id: true, status: true, customerName: true },
  })
  if (!order) throw new NotFoundError('Order not found')
  if (['COMPLETED', 'CANCELLED', 'DELETED'].includes(order.status)) {
    throw new BadRequestError('La cuenta ya está cerrada')
  }
  // 🔴 R4-2 (ronda 4 post-QA de sellos tardíos; decisión «A»): una venta YA COBRADA puede no estar COMPLETED (la liquidó el panel
  // con `settleOrder`, que no cambia el estado, o el PUT del panel le cambió el estado). `Order.customerId` es el respaldo
  // heredado de la lealtad: cambiar el cliente de una venta cobrada sin `payments:create` ⇒ 403 y no se guarda nada (la misma
  // regla que el PUT del panel). Decidido bajo el candado de la venta, tomado arriba. `null` = «sin cambio» (ver abajo).
  if (input.customerId !== undefined && input.customerId !== null) {
    await asegurarCambioDeClienteBajoCandado(tx, {
      venueId,
      orderId,
      clienteNuevo: input.customerId || null,
      puedeCobrar: opciones.puedeCambiarClienteEnVentaCobrada === true,
    })
  }

  // Partial-update semantics tolerant to clients that serialize defaults
  // (Android's kotlinx encodeDefaults=true sends null for untouched fields):
  // null/undefined = no change; EMPTY STRING clears name/notes/customer.
  const data: Record<string, unknown> = {}
  if (input.name !== undefined && input.name !== null) data.customerName = input.name.trim() || null
  if (input.notes !== undefined && input.notes !== null) data.specialRequests = input.notes.trim() || null
  if (input.covers !== undefined && input.covers !== null) {
    if (input.covers < 1 || input.covers > 200) throw new BadRequestError('covers inválido')
    data.covers = input.covers
  }
  if (input.orderType !== undefined && input.orderType !== null && input.orderType !== '') {
    const valid = ['DINE_IN', 'TAKEOUT', 'DELIVERY', 'PICKUP']
    if (!valid.includes(input.orderType)) throw new BadRequestError('orderType inválido')
    data.type = input.orderType
  }
  if (input.customerId !== undefined && input.customerId !== null) {
    if (input.customerId) {
      const customer = await tx.customer.findFirst({
        where: { id: input.customerId, venueId },
        select: { id: true, firstName: true, lastName: true },
      })
      if (!customer) throw new BadRequestError('Cliente no encontrado en este venue')
      data.customerId = customer.id
      // Follow the customer's name on the check label ONLY when the check has
      // no explicit name yet (never clobber a name the waiter typed). Checked
      // against the STORED name because clients that serialize defaults send
      // name:null on every call.
      if (!order.customerName && data.customerName === undefined) {
        data.customerName = `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || null
      }
    } else {
      // Empty string detaches the customer.
      data.customerId = null
    }
  }
  if (Object.keys(data).length === 0) throw new BadRequestError('Nada que actualizar')

  const updated = await tx.order.update({
    where: { id: order.id },
    data,
    select: { customerName: true, specialRequests: true, covers: true, customerId: true, type: true },
  })

  // Cambiar el conteo de comensales puede disparar (o retirar) el cargo
  // automático por grupo — el cargo debe seguir al conteo, no quedarse pegado.
  if (input.covers != null) {
    const { syncAutomaticServiceChargesInTransaction } = await import('./service-charge.mobile.service')
    await syncAutomaticServiceChargesInTransaction(tx, venueId, orderId, charges)
  }

  return {
    data: {
      name: updated.customerName,
      notes: updated.specialRequests,
      covers: updated.covers,
      customerId: updated.customerId,
      orderType: updated.type,
    },
    affectedServiceChargeIds: [...new Set([...charges.createdIds, ...charges.deletedIds, ...charges.recalculatedIds])],
  }
}

export async function updateOrderDetails(
  venueId: string,
  orderId: string,
  input: OrderDetailsInput,
  opciones: OpcionesDeDetalleDeCuenta = {},
) {
  const result = await prisma.$transaction(
    tx => updateOrderDetailsInTransaction(tx, venueId, orderId, input, opciones),
    ORDER_LOCK_WAIT_BUDGET,
  )
  return result.data
}

// MARK: - Table order discounts (check panel "Descuentos")

/**
 * TABLE_SERVICE — applies a catalog ORDER-scope discount to the open check
 * and recomputes totals (same recalc the comp path uses, so % discounts
 * re-derive consistently).
 */
export async function applyOrderDiscountInTransaction(
  tx: Prisma.TransactionClient,
  venueId: string,
  orderId: string,
  discountId: string,
  _staffId?: string,
) {
  const { recalculateOrderTotals } = await import('./comp-item.mobile.service')

  // 🔴 Candado de la orden (Plan3b) ANTES de leer: estado, subtotal, descuentos ya aplicados y la regla del catálogo
  // se leen bajo él, y la fila del descuento y los totales se escriben en la MISMA transacción.
  if (!(await lockExistingOrderForPayment(tx, { venueId, orderId }))) throw new NotFoundError('Order not found')
  const order = await tx.order.findFirst({
    where: { id: orderId, venueId },
    select: { id: true, paymentStatus: true, discountAmount: true, paidAmount: true, subtotal: true, originSystem: true },
  })
  if (!order) throw new NotFoundError('Order not found')
  // R11 (Codex r5): la cabecera de una importada manda y sus renglones traen el IVA dentro y por pieza; rearmarla aquí cobraría
  // el IVA dos veces (P12). Esos cambios se hacen en el POS externo.
  rechazarSiEsImportada(order)
  await rechazarSiEsCuentaDeTarjetas(tx, orderId, 'descuentos')
  if (order.paymentStatus === 'PAID' || order.paymentStatus === 'PARTIAL') {
    throw new BadRequestError('No se puede descontar una orden ya pagada')
  }

  const discount = await tx.discount.findFirst({ where: { id: discountId, venueId } })
  if (!discount) throw new NotFoundError('Descuento no encontrado')
  validateDiscountActive(discount)
  if (discount.scope !== 'ORDER') {
    throw new BadRequestError('Solo descuentos de orden aplican a la cuenta completa')
  }

  const dup = await tx.orderDiscount.findFirst({ where: { orderId, discountId } })
  if (dup) throw new BadRequestError('Ese descuento ya está aplicado a la cuenta')

  const subtotal = Number(order.subtotal)
  const value = Number(discount.value)

  // 🔴 MONEY: sólo se puede descontar lo que TODAVÍA no está descontado.
  //
  // Topar contra el subtotal COMPLETO no basta cuando la cuenta ya trae
  // descuentos: DOS descuentos fijos de $200 sobre una cuenta de $253 dejaban
  // `discountAmount` en $425.30 — casi el doble de la mercancía. El total no
  // sale negativo porque `recalculateOrderTotals` lo clampa, pero el número
  // GUARDADO miente, y es el que alimenta reportes, comisiones y la factura
  // (CFDI40111 exige que el descuento del comprobante sea la suma de los
  // descuentos de los conceptos: $425.30 sobre conceptos que suman $253 es
  // imposible de timbrar). Reproducido en vivo el 2026-08-09.
  //
  // Espejo de `applyDiscount` en order.tpv.service.ts y del
  // `remainingDiscountable` que ya usan discount.tpv.service.ts y
  // discountEngine.service.ts.
  const remainingDiscountable = Math.max(0, subtotal - Number(order.discountAmount || 0))
  const rawAmount = discount.type === 'PERCENTAGE' ? Math.round(((subtotal * value) / 100) * 100) / 100 : Math.min(value, subtotal)
  // R6 (founder, 2-oct): el tope del catálogo vale al aplicar y, viajando en el reparto, al recalcular. Hoy el móvil lo
  // ignoraba. Un tope que no es nulo cuenta, incluido 0 (Codex r1), igual que el cupón y el motor.
  const tope = discount.type === 'PERCENTAGE' && discount.maxDiscountAmount != null ? Number(discount.maxDiscountAmount) : null
  const amount = Math.min(rawAmount, tope ?? Infinity, remainingDiscountable)

  // Codex r1 P1: lo que la cabecera trae fuera de toda fila (orden anterior a B2…) queda en su fila antes de crear ésta.
  await conservarDescuentoHistorico(tx, orderId, order.discountAmount)
  const row = await tx.orderDiscount.create({
    data: {
      orderId,
      discountId,
      type: discount.type,
      name: discount.name,
      value: discount.value,
      amount,
      // Su recálculo, en esta misma tx, la sincroniza (y la vuelve regla de recálculo) respetando el tope.
      reparto: comoJson(nuevoRepartoDeCuenta({ conPromociones: true, tope })),
    },
    select: { id: true, name: true, amount: true },
  })

  const totals = await recalculateOrderTotals(orderId, 0, Number(order.paidAmount || 0), tx)
  return { row, totals }
}

export async function applyOrderDiscount(venueId: string, orderId: string, discountId: string, staffId?: string) {
  const { row, totals } = await prisma.$transaction(
    tx => applyOrderDiscountInTransaction(tx, venueId, orderId, discountId, staffId),
    ORDER_LOCK_WAIT_BUDGET,
  )

  void (await import('../dashboard/activity-log.service')).logAction({
    action: 'ORDER_DISCOUNT_APPLIED',
    entity: 'Order',
    entityId: orderId,
    staffId,
    venueId,
    data: { discountId, name: row.name, amount: Number(row.amount) },
  })

  return { orderDiscountId: row.id, name: row.name, amount: Number(row.amount), ...totals }
}

/** Removes one applied order discount and recomputes totals. */
export async function removeOrderDiscountInTransaction(
  tx: Prisma.TransactionClient,
  venueId: string,
  orderId: string,
  orderDiscountId: string,
  staffId?: string,
) {
  // 🔴 MONEY: a discount that came from redeeming loyalty points must give the
  // points BACK when it is removed — otherwise the customer paid with points
  // for a discount that no longer exists. Both moves share one transaction.
  const { refundLoyaltyForOrderDiscount } = await import('./loyalty.mobile.service')
  const { recalculateOrderTotals } = await import('./comp-item.mobile.service')
  // 🔴 MISMA regla para el premio de una cartilla de sellos: si se quita su descuento,
  // el premio vuelve a estar disponible. Sin esto el cliente pagó siete visitas por un
  // descuento que ya no existe y el premio queda marcado como canjeado para siempre.
  // Va en la MISMA transacción por la misma razón que los puntos.
  const { refundStampRewardForOrderDiscount } = await import('../wallet/redeemStampReward.service')
  // 🔴 Candado de la orden (Plan3b) antes que el cliente y el premio (Order → Customer/StampReward): se releen la orden
  // y la fila del descuento bajo él, y devoluciones + borrado + totales van en la misma transacción.
  if (!(await lockExistingOrderForPayment(tx, { venueId, orderId }))) throw new NotFoundError('Order not found')
  const order = await tx.order.findFirst({
    where: { id: orderId, venueId },
    select: { id: true, paymentStatus: true, paidAmount: true, discountAmount: true, originSystem: true },
  })
  if (!order) throw new NotFoundError('Order not found')
  // R11 (Codex r5): la cabecera de una importada manda y sus renglones traen el IVA dentro y por pieza; rearmarla aquí cobraría
  // el IVA dos veces (P12). Esos cambios se hacen en el POS externo.
  rechazarSiEsImportada(order)
  await rechazarSiEsCuentaDeTarjetas(tx, orderId, 'cambios de descuento')
  if (order.paymentStatus === 'PAID' || order.paymentStatus === 'PARTIAL') {
    throw new BadRequestError('No se puede modificar una orden ya pagada')
  }

  const row = await tx.orderDiscount.findFirst({ where: { id: orderDiscountId, orderId } })
  if (!row) throw new NotFoundError('Descuento no aplicado a esta orden')
  // R7-1 (ruling de B2 «al retirar un descuento, antes de borrarlo»): el recálculo de abajo es Σ filas, así que un resto de
  // cabecera sin fila se perdería con ésta; se congela antes de devolver, revertir y borrar.
  await conservarDescuentoHistorico(tx, orderId, order.discountAmount)

  const refunded = await refundLoyaltyForOrderDiscount(tx, venueId, row, staffId)
  const stamp = await refundStampRewardForOrderDiscount(tx, venueId, row)
  // R3-2: si la fila era espejo, su renglón deja de traer el descuento; el recálculo de abajo sincroniza los repartos.
  await revertirDescuentoDelRenglon(tx, orderId, row)
  // D16 (Codex r1 #3): quitar una fila devuelve el impuesto que restó, igual que el motor. Una fila vieja del 16 % deja así
  // de dejar la orden en impuesto negativo; una nueva IVA_APARTE recupera su impuesto. El recálculo de abajo no toca
  // `taxAmount`; su sincronización mueve lo que cambie al re-repartir otras filas.
  const impuestoDevuelto = new Prisma.Decimal(row.taxReduction ?? 0)
  if (impuestoDevuelto.gt(0)) await tx.order.update({ where: { id: orderId }, data: { taxAmount: { increment: impuestoDevuelto } } })
  await tx.orderDiscount.delete({ where: { id: row.id } })
  const t = await recalculateOrderTotals(orderId, 0, Number(order.paidAmount || 0), tx)
  return { row, refund: refunded, stampRefund: stamp, totals: t }
}

export async function removeOrderDiscount(venueId: string, orderId: string, orderDiscountId: string, staffId?: string) {
  const { row, refund, stampRefund, totals } = await prisma.$transaction(
    tx => removeOrderDiscountInTransaction(tx, venueId, orderId, orderDiscountId, staffId),
    ORDER_LOCK_WAIT_BUDGET,
  )

  void (await import('../dashboard/activity-log.service')).logAction({
    action: 'ORDER_DISCOUNT_REMOVED',
    entity: 'Order',
    entityId: orderId,
    staffId,
    venueId,
    data: {
      orderDiscountId,
      name: row.name,
      pointsRefunded: refund?.pointsRefunded ?? 0,
      stampRewardReturned: stampRefund?.rewardId ?? null,
      taxReturned: Number(row.taxReduction ?? 0),
    },
  })

  return totals
}

// MARK: - Separate checks (Square: dividir en cuentas separadas)

/**
 * TABLE_SERVICE — splits the selected SENT items of an open check into a NEW
 * check on the SAME table (Square's separate checks). The source keeps the
 * rest; both orders' money is recomputed from their items. The table stays
 * OCCUPIED; currentOrderId keeps pointing at the source.
 */
export async function splitOrderItemsInTransaction(
  tx: Prisma.TransactionClient,
  venueId: string,
  orderId: string,
  itemIds: string[],
  staffId?: string,
  strictItems = false,
) {
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    throw new BadRequestError('itemIds es requerido')
  }
  const { recalculateOrderTotals } = await import('./comp-item.mobile.service')
  try {
    await lockTableOrderScope(tx, { venueId, orderIds: [orderId] })
  } catch (error) {
    if (error instanceof NotFoundError && error.message === 'Venue not found') throw new NotFoundError('Order not found')
    throw error
  }
  const source = await tx.order.findFirst({
    where: { id: orderId, venueId },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      paymentStatus: true,
      tableId: true,
      covers: true,
      servedById: true,
      type: true,
      paidAmount: true,
      shiftId: true,
      contratoDePrecio: true,
      originSystem: true,
      areaTicketCheckoutSession: { select: { id: true } },
      items: { select: { id: true, orderPromotionId: true, areaTicketLineId: true } },
      orderDiscounts: { select: { id: true } },
      serviceCharges: { select: { id: true, isAutomatic: true } },
    },
  })
  if (!source) throw new NotFoundError('Order not found')
  // R11 (Codex r5): la cabecera de una importada manda y sus renglones traen el IVA dentro y por pieza; rearmarla aquí cobraría
  // el IVA dos veces (P12). Esos cambios se hacen en el POS externo.
  rechazarSiEsImportada(source)
  await rechazarSiEsCuentaDeTarjetas(tx, orderId, 'divisiones de cuenta')
  if (['COMPLETED', 'CANCELLED', 'DELETED'].includes(source.status)) {
    throw new BadRequestError('La cuenta ya está cerrada')
  }
  if (source.paymentStatus === 'PAID' || source.paymentStatus === 'PARTIAL') {
    throw new BadRequestError('No se puede separar una cuenta ya pagada')
  }
  // 🔴 R14-1 (founder, 17-oct): una cuenta con vales de mostrador no se separa; se paga con abonos en la misma cuenta.
  rechazarSiLaCuentaTieneVales(source)
  // 🔴 MONEY (auditoría): mismos guards que fusionar — un descuento/canje/cargo
  // se calculó sobre la cuenta COMPLETA; partirla cambiaría la base en silencio.
  if (source.orderDiscounts.length > 0) {
    throw new BadRequestError(
      'Quita los descuentos (o la recompensa) antes de separar la cuenta: su monto se calculó sobre la cuenta completa.',
    )
  }
  if (source.serviceCharges.some(sc => !sc.isAutomatic)) {
    throw new BadRequestError('Quita los cobros por servicio antes de separar la cuenta.')
  }

  const sourceItemIds = new Set(source.items.map(i => i.id))
  if (strictItems) {
    if (new Set(itemIds).size !== itemIds.length)
      throw new BadRequestError('No repitas artículos al separar la cuenta', 'SPLIT_DUPLICATE_ITEM_IDS')
    if (itemIds.some(id => !sourceItemIds.has(id)))
      throw new BadRequestError('Todos los artículos deben pertenecer a esta cuenta', 'SPLIT_ITEM_NOT_IN_SOURCE')
  }
  const toMove = itemIds.filter(id => sourceItemIds.has(id))
  if (toMove.length === 0) throw new BadRequestError('Los artículos no pertenecen a esta cuenta')
  if (toMove.length >= sourceItemIds.size) {
    throw new BadRequestError('Debe quedar al menos un artículo en la cuenta original')
  }

  // 🔴 Una promoción se mueve COMPLETA o no se mueve (audit 2026-08-13): mover
  // sólo el refresco de un combo dejaría la instancia (OrderPromotion) en el
  // origen mientras sus líneas viven en dos cheques — cada uno vería un
  // subconjunto "completo" y el guard de reembolso dejaría de proteger.
  const movingSet = new Set(toMove)
  const promoLineCount = new Map<string, { total: number; moving: number }>()
  for (const item of source.items) {
    if (!item.orderPromotionId) continue
    const entry = promoLineCount.get(item.orderPromotionId) ?? { total: 0, moving: 0 }
    entry.total += 1
    if (movingSet.has(item.id)) entry.moving += 1
    promoLineCount.set(item.orderPromotionId, entry)
  }
  const movedPromotionIds: string[] = []
  for (const [orderPromotionId, count] of promoLineCount) {
    if (count.moving > 0 && count.moving < count.total) {
      throw new BadRequestError('Una promoción se mueve completa a la otra cuenta: selecciona todos sus artículos o ninguno.')
    }
    if (count.moving === count.total && count.moving > 0) movedPromotionIds.push(orderPromotionId)
  }

  const created = await tx.order.create({
    data: {
      venueId,
      // 🔴 El cheque separado HEREDA el turno de su origen, no «el turno abierto ahora»:
      // es la MISMA comida, y separar la cuenta a caballo de un cambio de turno la partiría
      // entre dos cortes. Heredar es un hecho copiado; resolver sería una suposición.
      // Si el origen no tiene turno, el hijo tampoco — no se inventa uno.
      shiftId: source.shiftId,
      tableId: source.tableId,
      covers: source.covers,
      orderNumber: `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      servedById: source.servedById,
      type: source.type,
      status: 'PENDING',
      paymentStatus: 'PENDING',
      kitchenStatus: 'PENDING',
      subtotal: 0,
      discountAmount: 0,
      taxAmount: 0,
      total: 0,
      version: 1,
      // Separar cuenta no cambia el precio que el cliente ya vio: la cuenta nueva
      // hereda el mismo contrato del origen, nunca se resuelve de nuevo.
      contratoDePrecio: source.contratoDePrecio,
    },
    select: { id: true, orderNumber: true, version: true },
  })

  await tx.orderItem.updateMany({
    where: { id: { in: toMove }, orderId: source.id },
    data: { orderId: created.id },
  })

  // La INSTANCIA de cada promoción movida completa sigue a sus líneas: si se
  // quedara en el origen, el histórico y el guard de reembolso apuntarían a
  // un cheque que ya no tiene esas líneas.
  if (movedPromotionIds.length > 0) {
    await tx.orderPromotion.updateMany({
      where: { id: { in: movedPromotionIds }, orderId: source.id },
      data: { orderId: created.id },
    })
  }

  const src = await recalculateOrderTotals(source.id, 0, Number(source.paidAmount || 0), tx)
  const dst = await recalculateOrderTotals(created.id, 0, 0, tx)
  return {
    source,
    newOrder: created,
    movedCount: toMove.length,
    sourceTotals: src,
    newTotals: dst,
    movedItemIds: toMove,
    movedPromotionIds,
  }
}

export async function splitOrderItems(venueId: string, orderId: string, itemIds: string[], staffId?: string) {
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    throw new BadRequestError('itemIds es requerido')
  }

  const { source, newOrder, movedCount, sourceTotals, newTotals } = await prisma.$transaction(
    tx => splitOrderItemsInTransaction(tx, venueId, orderId, itemIds, staffId),
    ORDER_LOCK_WAIT_BUDGET,
  )

  void (await import('../dashboard/activity-log.service')).logAction({
    action: 'ORDER_SPLIT',
    entity: 'Order',
    entityId: source.id,
    staffId,
    venueId,
    data: { newOrderId: newOrder.id, newOrderNumber: newOrder.orderNumber, items: movedCount },
  })

  return {
    source: { id: source.id, orderNumber: source.orderNumber, total: sourceTotals.total, version: sourceTotals.version },
    created: { id: newOrder.id, orderNumber: newOrder.orderNumber, total: newTotals.total, version: newTotals.version },
  }
}

/**
 * "Dividir por puesto" (Square): arma un cheque por ASIENTO en UNA transacción.
 *
 * 🔴 Por qué una sola transacción y no N llamadas al split normal: si la mesa
 * tiene 8 asientos y la llamada 5 falla, la cuenta queda partida a medias y el
 * mesero no sabe qué cobró. O se parte completa, o no se parte.
 *
 * Reglas:
 * - Las líneas SIN asiento se quedan en la cuenta original (no se inventa dueño).
 * - El asiento más bajo también se queda en la original, para que nunca quede
 *   vacía y para conservar su historial (es "la cuenta de la mesa").
 * - Requiere al menos 2 asientos distintos; si no, no hay nada que dividir.
 */
export async function splitOrderBySeatInTransaction(tx: Prisma.TransactionClient, venueId: string, orderId: string, staffId?: string) {
  const { recalculateOrderTotals } = await import('./comp-item.mobile.service')
  try {
    await lockTableOrderScope(tx, { venueId, orderIds: [orderId] })
  } catch (error) {
    if (error instanceof NotFoundError && error.message === 'Venue not found') throw new NotFoundError('Order not found')
    throw error
  }
  const source = await tx.order.findFirst({
    where: { id: orderId, venueId },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      paymentStatus: true,
      tableId: true,
      covers: true,
      servedById: true,
      type: true,
      paidAmount: true,
      shiftId: true,
      contratoDePrecio: true,
      originSystem: true,
      areaTicketCheckoutSession: { select: { id: true } },
      items: { select: { id: true, seat: true, areaTicketLineId: true } },
      orderDiscounts: { select: { id: true } },
      serviceCharges: { select: { id: true, isAutomatic: true } },
    },
  })
  if (!source) throw new NotFoundError('Order not found')
  // R11 (Codex r5): la cabecera de una importada manda y sus renglones traen el IVA dentro y por pieza; rearmarla aquí cobraría
  // el IVA dos veces (P12). Esos cambios se hacen en el POS externo.
  rechazarSiEsImportada(source)
  await rechazarSiEsCuentaDeTarjetas(tx, orderId, 'divisiones de cuenta')
  if (['COMPLETED', 'CANCELLED', 'DELETED'].includes(source.status)) {
    throw new BadRequestError('La cuenta ya está cerrada')
  }
  if (source.paymentStatus === 'PAID' || source.paymentStatus === 'PARTIAL') {
    throw new BadRequestError('No se puede dividir una cuenta ya pagada')
  }
  // 🔴 R14-1: una cuenta con vales de mostrador no se divide por puesto (mismo guarda que separar).
  rechazarSiLaCuentaTieneVales(source)
  // 🔴 MONEY (auditoría): mismos guards que fusionar — descuentos/canjes/cargos
  // se calcularon sobre la cuenta completa; dividirla cambiaría la base.
  if (source.orderDiscounts.length > 0) {
    throw new BadRequestError('Quita los descuentos (o la recompensa) antes de dividir por puesto.')
  }
  if (source.serviceCharges.some(sc => !sc.isAutomatic)) {
    throw new BadRequestError('Quita los cobros por servicio antes de dividir por puesto.')
  }

  // Agrupar por asiento; las líneas sin asiento no se mueven.
  const bySeat = new Map<number, string[]>()
  for (const item of source.items) {
    if (item.seat == null) continue
    const list = bySeat.get(item.seat) ?? []
    list.push(item.id)
    bySeat.set(item.seat, list)
  }

  const seats = [...bySeat.keys()].sort((a, b) => a - b)
  if (seats.length < 2) {
    throw new BadRequestError('Se necesitan al menos dos asientos con artículos para dividir por puesto')
  }

  // El asiento más bajo se queda en la cuenta original.
  const seatsToMove = seats.slice(1)

  const movedItemIds: string[] = []
  const results: Array<{ id: string; orderNumber: string; seat: number }> = []
  for (const seat of seatsToMove) {
    const itemIds = bySeat.get(seat) as string[]
    const newOrder = await tx.order.create({
      data: {
        venueId,
        // 🔴 Mismo criterio que separar cheque: el turno se HEREDA del origen (es la misma
        // comida), nunca se resuelve «el turno abierto ahora» — dividir por puesto a caballo
        // de un cambio de turno partiría una sola mesa entre dos cortes.
        shiftId: source.shiftId,
        tableId: source.tableId,
        // Un cheque POR ASIENTO es de UNA persona: heredar los covers de la
        // mesa inflaría el conteo y dispararía cargos automáticos por grupo.
        covers: 1,
        orderNumber: `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 4).toUpperCase()}-S${seat}`,
        customerName: `Asiento ${seat}`,
        servedById: source.servedById,
        type: source.type,
        status: 'PENDING',
        paymentStatus: 'PENDING',
        kitchenStatus: 'PENDING',
        subtotal: 0,
        discountAmount: 0,
        taxAmount: 0,
        total: 0,
        version: 1,
        // Dividir por puesto no cambia el precio que el cliente ya vio: cada
        // cheque por asiento hereda el mismo contrato del origen.
        contratoDePrecio: source.contratoDePrecio,
      },
      select: { id: true, orderNumber: true },
    })
    await tx.orderItem.updateMany({
      where: { id: { in: itemIds }, orderId: source.id },
      data: { orderId: newOrder.id },
    })
    movedItemIds.push(...itemIds)
    results.push({ id: newOrder.id, orderNumber: newOrder.orderNumber, seat })
  }

  // 🔴 Recalcular DENTRO de la tx (auditoría): un crash después del commit y
  // antes del recálculo dejaría el origen sobre-cobrando los asientos movidos.
  const src = await recalculateOrderTotals(source.id, 0, Number(source.paidAmount || 0), tx)
  const totalsPerSeat = []
  for (const r of results) {
    const t = await recalculateOrderTotals(r.id, 0, 0, tx)
    totalsPerSeat.push({ id: r.id, orderNumber: r.orderNumber, seat: r.seat, total: t.total })
  }
  return { source, seats, seatsToMove, results: totalsPerSeat, sourceTotals: src, movedItemIds }
}

export async function splitOrderBySeat(venueId: string, orderId: string, staffId?: string) {
  const created = await prisma.$transaction(tx => splitOrderBySeatInTransaction(tx, venueId, orderId, staffId), ORDER_LOCK_WAIT_BUDGET)

  const createdTotals = created.results
  const sourceTotals = created.sourceTotals

  void (await import('../dashboard/activity-log.service')).logAction({
    action: 'ORDER_SPLIT_BY_SEAT',
    entity: 'Order',
    entityId: created.source.id,
    staffId,
    venueId,
    data: { seats: created.seatsToMove, created: created.results.length },
  })

  return {
    source: { id: created.source.id, orderNumber: created.source.orderNumber, total: sourceTotals.total, seat: created.seats[0] },
    created: createdTotals,
  }
}

/**
 * "Fusionar cuentas" (Square's merge): vuelca TODOS los artículos de una cuenta
 * en otra y cierra la de origen. Es lo que se necesita cuando dos mesas se
 * juntan, y es el INVERSO de dividir — sin esto, una división por error solo se
 * deshace anulando cheques y recapturando todo.
 *
 * 🔴 MONEY — por qué se RECHAZA en vez de "resolver" solo:
 * Si el origen trae descuentos de orden, cobros por servicio manuales o un canje
 * de puntos, esos montos se calcularon sobre SU base. Al fusionar, la base cambia:
 * un 10% sobre $200 no es el mismo dinero que un 10% sobre $500. Arrastrarlos
 * cambiaría el cobro en silencio, y descartarlos regalaría (o cobraría de más).
 * Se pide quitarlos primero, con el motivo explícito. Los cobros AUTOMÁTICOS por
 * comensales se re-aplican solos en el destino, así que esos no estorban.
 */
export async function mergeOrdersInTransaction(
  tx: Prisma.TransactionClient,
  venueId: string,
  targetOrderId: string,
  sourceOrderId: string,
  staffId?: string,
) {
  if (targetOrderId === sourceOrderId) {
    throw new BadRequestError('No se puede fusionar una cuenta consigo misma')
  }

  let scope: Awaited<ReturnType<typeof lockTableOrderScope>>
  try {
    scope = await lockTableOrderScope(tx, { venueId, orderIds: [targetOrderId, sourceOrderId] })
  } catch (error) {
    // Failed topology discovery performs no mutation; identify the original missing-side DTO.
    if (error instanceof NotFoundError) {
      const existingTarget = await tx.order.findFirst({ where: { id: targetOrderId, venueId }, select: { id: true } })
      if (!existingTarget) throw new NotFoundError('Cuenta destino no encontrada')
      const existingSource = await tx.order.findFirst({ where: { id: sourceOrderId, venueId }, select: { id: true } })
      if (!existingSource) throw new NotFoundError('Cuenta origen no encontrada')
    }
    throw error
  }
  // R14-1: lo que dice si un lado es cuenta con vales (su sesión, o un renglón de vale de una cuenta ya dividida antes).
  const valesDeLaCuenta = {
    areaTicketCheckoutSession: { select: { id: true } },
    items: { where: { areaTicketLineId: { not: null } }, select: { areaTicketLineId: true }, take: 1 },
  } as const
  const [target, source] = await Promise.all([
    tx.order.findFirst({
      where: { id: targetOrderId, venueId },
      select: { id: true, orderNumber: true, status: true, paymentStatus: true, paidAmount: true, tableId: true, ...valesDeLaCuenta },
    }),
    tx.order.findFirst({
      where: { id: sourceOrderId, venueId },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        paymentStatus: true,
        tableId: true,
        customerName: true,
        _count: { select: { items: true } },
        orderDiscounts: { select: { id: true }, take: 1 },
        serviceCharges: { where: { isAutomatic: false }, select: { id: true, isAutomatic: true }, take: 1 },
        ...valesDeLaCuenta,
      },
    }),
  ])
  if (!target) throw new NotFoundError('Cuenta destino no encontrada')
  const validatedTargetId = target.id
  if (!source) throw new NotFoundError('Cuenta origen no encontrada')

  for (const [order, label] of [
    [target, 'destino'],
    [source, 'origen'],
  ] as const) {
    if (['COMPLETED', 'CANCELLED', 'DELETED'].includes(order.status)) {
      throw new BadRequestError(`La cuenta ${label} ya está cerrada`)
    }
    if (order.paymentStatus === 'PAID' || order.paymentStatus === 'PARTIAL') {
      throw new BadRequestError(`La cuenta ${label} ya tiene pagos; no se puede fusionar`)
    }
  }
  // 🔴 R14-1 (founder, 17-oct): ni la venta de vales se junta en otra (su sesión quedaba huérfana y sus renglones fuera de su vale) ni
  // otra cuenta se junta en ella (decisión de esta ronda: la sesión y su saldo lo soportarían, pero la cuenta con vales no se junta).
  rechazarSiLaCuentaTieneVales(target, source)

  if (source._count.items === 0) {
    throw new BadRequestError('La cuenta origen no tiene artículos')
  }
  if (source.orderDiscounts.length > 0) {
    throw new BadRequestError(
      'Quita los descuentos (o la recompensa) de la cuenta origen antes de fusionarla: su monto se calculó sobre esa cuenta.',
    )
  }
  const manualCharges = source.serviceCharges.filter(sc => !sc.isAutomatic)
  if (manualCharges.length > 0) {
    throw new BadRequestError('Quita los cobros por servicio de la cuenta origen antes de fusionarla.')
  }

  const { recalculateOrderTotals } = await import('./comp-item.mobile.service')
  const freshSource = await tx.order.findFirst({
    where: {
      id: source.id,
      venueId,
      status: { notIn: ['COMPLETED', 'CANCELLED', 'DELETED'] },
      paymentStatus: { notIn: ['PAID', 'PARTIAL'] },
    },
    select: {
      id: true,
      specialRequests: true,
      contratoDePrecio: true,
      originSystem: true,
      taxAmount: true,
      _count: { select: { items: true } },
      orderDiscounts: { select: { id: true }, take: 1 },
      serviceCharges: { where: { isAutomatic: false }, select: { id: true, isAutomatic: true }, take: 1 },
    },
  })
  const freshTarget = await tx.order.findFirst({
    where: {
      id: target.id,
      venueId,
      status: { notIn: ['COMPLETED', 'CANCELLED', 'DELETED'] },
      paymentStatus: { notIn: ['PAID', 'PARTIAL'] },
    },
    select: { id: true, specialRequests: true, contratoDePrecio: true, paidAmount: true, originSystem: true },
  })
  if (!freshSource || !freshTarget) {
    throw new BadRequestError('La cuenta cambió mientras se fusionaba — vuelve a intentar')
  }
  // R11 (Codex r5): la cabecera de una importada manda y sus renglones traen el IVA dentro y por pieza; fusionarla (en
  // cualquiera de los dos lados) rearmaría su dinero aquí y cobraría el IVA dos veces (P12). Se junta en el POS externo.
  rechazarSiEsImportada(freshSource)
  rechazarSiEsImportada(freshTarget)
  await rechazarSiEsCuentaDeTarjetas(tx, sourceOrderId, 'uniones con otra cuenta')
  await rechazarSiEsCuentaDeTarjetas(tx, targetOrderId, 'uniones con otra cuenta')
  if (freshSource._count.items === 0) {
    throw new BadRequestError('La cuenta origen no tiene artículos')
  }
  if (freshSource.orderDiscounts.length > 0 || freshSource.serviceCharges.some(sc => !sc.isAutomatic)) {
    throw new BadRequestError('La cuenta origen recibió descuentos o cobros durante la fusión — vuelve a intentar')
  }
  // Fusionar CANCELA el origen: un cobro de terminal sin desenlace acreditado sobre él aterrizaría en una orden
  // cancelada. Mismo 409 que `cancelOrder`, con `orderId` aditivo para decir cuál cuenta lo tiene. El DESTINO no se
  // bloquea (decisión G3): sumarle renglones no crea sobrepago.
  await assertNoLiveTerminalCharge(
    tx,
    { venueId, orderId: source.id },
    {
      mensaje: 'La cuenta origen tiene un cobro en curso en la terminal. Cancela o espera el resultado del cobro antes de fusionarla.',
      detallesExtra: { orderId: source.id },
    },
  )

  const movedItemIds: string[] = [],
    promotionIds = new Set<string>(),
    deletedChargeIds: string[] = []
  let cursor: string | undefined
  for (;;) {
    const page = await tx.orderItem.findMany({
      where: { orderId: source.id },
      select: { id: true, orderPromotionId: true },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    for (const item of page) {
      movedItemIds.push(item.id)
      if (item.orderPromotionId) promotionIds.add(item.orderPromotionId)
    }
    if (page.length < 100) break
    cursor = page[page.length - 1].id
  }
  cursor = undefined
  for (;;) {
    const page: { id: string }[] = await tx.orderServiceCharge.findMany({
      where: { orderId: source.id },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    deletedChargeIds.push(...page.map(charge => charge.id))
    if (page.length < 100) break
    cursor = page[page.length - 1].id
  }
  async function targetChargeAmounts() {
    const amounts = new Map<string, Prisma.Decimal>()
    let chargeCursor: string | undefined
    for (;;) {
      const page = await tx.orderServiceCharge.findMany({
        where: { orderId: validatedTargetId },
        select: { id: true, amount: true },
        orderBy: { id: 'asc' },
        take: 100,
        ...(chargeCursor ? { cursor: { id: chargeCursor }, skip: 1 } : {}),
      })
      for (const charge of page) amounts.set(charge.id, charge.amount)
      if (page.length < 100) return amounts
      chargeCursor = page[page.length - 1].id
    }
  }
  const priorTargetCharges = await targetChargeAmounts()
  await tx.orderItem.updateMany({
    where: { orderId: source.id },
    data: { orderId: target.id },
  })
  // Los cobros automáticos del origen se van con él: el destino re-evalúa
  // los suyos por comensales en el recálculo.
  await tx.orderServiceCharge.deleteMany({ where: { orderId: source.id } })

  // Codex r5 #3: el IVA aparte del origen viaja con sus renglones; el origen cancelado queda fiscalmente no cobrable. Sólo el
  // positivo: un negativo viejo (el motor de antes de D16) no le baja la deuda al destino.
  const impuestoDelOrigen = Prisma.Decimal.max(0, new Prisma.Decimal(freshSource.taxAmount))

  // El destino se queda con el contrato COMBINADO (spec v5, `combinarContratos`): si origen y
  // destino coinciden, se conserva; si difieren, pasa a DESCONOCIDO — la fusión NUNCA se
  // bloquea por esto. Las notas de cocina del origen, de paso, NO se pierden: se anexan.
  await tx.order.update({
    where: { id: target.id },
    data: {
      contratoDePrecio: combinarContratos(freshTarget.contratoDePrecio, freshSource.contratoDePrecio),
      ...(impuestoDelOrigen.gt(0) ? { taxAmount: { increment: impuestoDelOrigen } } : {}),
      ...(freshSource.specialRequests?.trim()
        ? { specialRequests: [freshTarget.specialRequests, freshSource.specialRequests].filter(Boolean).join(' · ') }
        : {}),
    },
  })

  const removedSource = await tx.order.update({
    where: { id: source.id },
    data: {
      status: 'CANCELLED',
      specialRequests: `Fusionada en ${target.orderNumber}`,
      subtotal: 0,
      discountAmount: 0,
      serviceChargeAmount: 0,
      taxAmount: 0,
      total: 0,
      // Los escritores con CAS de versión (anular, descontar, rondas) se enteran de que el origen cambió.
      version: { increment: 1 },
    },
    select: { tableId: true },
  })

  const totals = await recalculateOrderTotals(target.id, 0, Number(freshTarget.paidAmount || 0), tx)
  const { syncAutomaticServiceChargesInTransaction } = await import('./service-charge.mobile.service')
  const chargeCapture: AutomaticServiceChargeCapture = { createdIds: [], deletedIds: [], recalculatedIds: [] }
  const finalTotals = (await syncAutomaticServiceChargesInTransaction(tx, venueId, target.id, chargeCapture)) ?? totals
  const currentTargetCharges = await targetChargeAmounts()
  for (const [id, amount] of currentTargetCharges) {
    const prior = priorTargetCharges.get(id)
    if (prior && !prior.equals(amount)) chargeCapture.recalculatedIds.push(id)
  }
  const { reconcileTableAfterOrderRemovedInTransaction } = await import('../tpv/table.tpv.service')
  const boundTable = scope.tables.find(table => table.currentOrderId === source.id)
  const reconciled = await reconcileTableAfterOrderRemovedInTransaction(tx, scope, source.id)
  // Shared legacy treats a found pointer as true even if its sibling remains occupied.
  const tableFreed = boundTable ? true : reconciled.tableFreed
  const ownTable = reconciled.tables.find(table => table.id === removedSource.tableId)
  const tpvTableFreed = Boolean(ownTable?.status === 'AVAILABLE' && ownTable.currentOrderId === null)
  const itemsCount = freshSource._count.items
  const affectedRefs: HttpEnvelope['affectedRefs'] = [
    { kind: 'Order', id: source.id },
    { kind: 'Order', id: target.id },
    ...movedItemIds.map(id => ({ kind: 'OrderItem' as const, id })),
    ...[...promotionIds].map(id => ({ kind: 'OrderPromotion' as const, id })),
    ...[...new Set([...deletedChargeIds, ...chargeCapture.createdIds, ...chargeCapture.deletedIds, ...chargeCapture.recalculatedIds])].map(
      id => ({ kind: 'OrderServiceCharge' as const, id }),
    ),
    ...reconciled.tables.map(table => ({ kind: 'Table' as const, id: table.id })),
  ]
  return {
    data: {
      target: { id: target.id, orderNumber: target.orderNumber, total: finalTotals.total, version: finalTotals.version },
      merged: { id: source.id, orderNumber: source.orderNumber, items: itemsCount },
      tableFreed,
    },
    source,
    target,
    itemsCount,
    tables: reconciled.tables,
    hadBoundTable: Boolean(boundTable),
    tpvTableFreed,
    affectedRefs,
  }
}

export async function publishMergedOrders(
  venueId: string,
  result: Awaited<ReturnType<typeof mergeOrdersInTransaction>>,
  staffId?: string,
): Promise<void> {
  const { source, target, itemsCount } = result
  const { onOrderCancelled } = await import('@/services/referrals/referralRefund.service')
  await onOrderCancelled({ orderId: source.id, venueId })
  await avisarOrdenCancelada(venueId, source.id, 'CANCELLED')
  // The old fallback reconciliation also published its captured final table status.
  if (!result.hadBoundTable) {
    const broadcastingService = socketManager.getBroadcastingService()
    for (const table of result.tables) {
      logger.info(`✅ [TABLE SERVICE] Table ${table.number} reconciled after order removal`)
      if (broadcastingService)
        broadcastingService.broadcastToVenue(venueId, SocketEventType.TABLE_STATUS_CHANGE, {
          tableId: table.id,
          tableNumber: table.number,
          status: table.status,
          orderId: table.currentOrderId,
          orderNumber: null,
          covers: null,
          waiter: null,
        })
    }
  }
  void (await import('../dashboard/activity-log.service')).logAction({
    action: 'ORDERS_MERGED',
    entity: 'Order',
    entityId: target.id,
    staffId,
    venueId,
    data: { sourceOrderId: source.id, sourceOrderNumber: source.orderNumber, items: itemsCount },
  })
}

export async function mergeOrders(venueId: string, targetOrderId: string, sourceOrderId: string, staffId?: string) {
  const result = await prisma.$transaction(
    tx => mergeOrdersInTransaction(tx, venueId, targetOrderId, sourceOrderId, staffId),
    ORDER_LOCK_WAIT_BUDGET,
  )
  await publishMergedOrders(venueId, result, staffId)
  return result.data
}

// MARK: - Cash Payment Types

export interface CashPaymentInput {
  /**
   * Huella del reducer offline: corre DENTRO de la transacción que crea el `Payment` (plan
   * 2026-10-13-sync-retoma-por-llave). Si lanza, el cobro entero se revierte.
   */
  dentroDeLaTx?: (tx: Prisma.TransactionClient, cobro: { orderId: string; paymentId: string }) => Promise<void>
  amount: number // cents
  tip?: number // cents
  staffId?: string
  // 🛡️ Idempotencia (patrón Stripe/Square/Toast): UUID generado UNA vez por
  // intento de cobro en el cliente y reenviado en CADA reintento. Sin esto, un
  // pago PARCIAL/dividido re-encolado offline crea un SEGUNDO Payment (doble
  // ingreso). El fast path (payment.tpv.service.ts) ya usa este patrón.
  idempotencyKey?: string
  /**
   * Cómo pagó realmente el cliente. Default CASH — los clientes viejos no lo
   * mandan y su comportamiento no cambia (ADITIVO).
   *
   * Existe porque el mesero a veces cobra por fuera de Avoqado: con una
   * terminal que no es nuestra, o con la nuestra cuando su SIM 4G aún no
   * reporta. Antes su única opción era marcarlo como efectivo, y eso rompía
   * el arqueo: el corte pedía dinero que no estaba en el cajón
   * (cashCloseout filtra por method=CASH).
   */
  method?: 'CASH' | 'CREDIT_CARD' | 'DEBIT_CARD' | 'BANK_TRANSFER' | 'OTHER'
  /**
   * Tipo de pago del catálogo del venue (VenueTenderType) — "Terminal BBVA",
   * "Vale de despensa", "Uber Eats". EXCLUYENTE con `method`: o el cliente manda
   * uno de los métodos fijos de siempre, o referencia un tender del catálogo.
   *
   * 🔴 Sólo viaja la REFERENCIA `{id, revision}`. La comisión, el "¿entra al
   * cajón?" y la forma SAT los resuelve el SERVER desde `VenueTenderTypeRevision`
   * (hallazgo P0 del audit v4): un POS con bug no puede inventarse una comisión.
   * La revisión se honra POR NÚMERO, así que un cobro encolado sin red conserva
   * la semántica que regía cuando se cobró, no la de hoy.
   */
  tenderTypeId?: string
  tenderRevision?: number
  /**
   * `true` cuando la venta viene de la cola offline: ya ocurrió. La ponen el reducer
   * (`sync.mobile.service.ts`, intent `PAY_CASH`) y la cola HTTP de Android e iOS
   * (`order.mobile.controller.ts`). Honra la revisión del tipo de pago que el cajero vio al
   * cobrar en vez de exigir la vigente, y dice que el dinero ya se capturó: sobre una cuenta
   * CANCELADA de Avoqado la reabre en vez de rechazarse (Tarea 6a). Es una declaración del
   * cliente (R14 f): uno que mienta sólo consigue que su efectivo se registre y la cuenta se
   * reabra, con rastro en `ORDER_REOPENED_BY_CAPTURED_PAYMENT`.
   */
  isOfflineReplay?: boolean
  /**
   * Quién procesó el cobro cuando NO fue Avoqado ("Clip", "terminal del
   * negocio", "transferencia BBVA"). Se guarda en Payment.externalSource, que
   * ya existía para anotaciones manuales. Es lo que permite responder cuánto
   * ingreso se está yendo por terminales ajenas.
   */
  externalSource?: string
}

export interface CashPaymentResponse {
  paymentId: string
  orderId: string
  orderNumber: string
  /** Lo REGISTRADO como pago, en centavos. Efectivo de cajón se limita al saldo; capturas externas conservan el importe real. */
  amount: number
  tipAmount: number
  method: PaymentMethod
  status: 'COMPLETED'
  /** Lo que sobró de `amount` solicitado sobre el saldo, en centavos: el cambio que debe dar el cajero. 0 si no sobró nada. */
  changeCents: number
  changeAmount?: number // Alias legacy opcional; `changeCents` es el campo autoritativo.
  // Digital receipt for the mobile client's receipt QR (customer display +
  // printed receipt). Same shape the TPV order/fast endpoints return. Null only
  // if receipt generation failed (never blocks the payment). ADDITIVE — old app
  // versions ignore it; card payments already get their key from the terminal.
  digitalReceipt?: { accessKey: string; receiptUrl: string; autofacturaAvailable: boolean } | null
  // Aviso de inventario post-cobro (Square-parity): el cobro SIEMPRE quedó
  // registrado; esto dice si el stock quedó en negativo o no se pudo descontar.
  // ADITIVO — las versiones viejas de la app lo ignoran.
  inventoryWarning?: OrderInventoryWarning

  // ── Saldo autoritativo de la orden (ADITIVO, opcional) ─────────────────────
  //
  // El server ya sabía todo esto dentro de la transacción del cobro y no lo
  // devolvía: el POS tenía que adivinar el restante con aritmética local del
  // carrito, que se desvía hasta centavos con promociones y cargos por
  // servicio, y no tenía forma de saber que la orden quedó PARTIAL.
  //
  // 🔴🔴 UNIDADES DE ESTA RESPUESTA: **TODO EN CENTAVOS, ENTEROS.**
  //
  //   Esta respuesta ES una frontera externa, y esta frontera habla centavos en
  //   las DOS direcciones: el cliente manda `amount`/`tip` en centavos (ver
  //   `order.mobile.controller.ts`: "amount es requerido ... (en centavos)") y
  //   el servicio los convierte con `amount / 100`. Internamente el cálculo
  //   sigue siendo pesos/`Decimal` como manda `.claude/rules/critical-warnings.md`;
  //   la conversión a centavos ocurre SÓLO al serializar, aquí.
  //
  //   ⚠️ `amount` y `tipAmount`, arriba, TAMBIÉN son centavos aunque su nombre no
  //   lo diga — son legado y no se pueden renombrar (hay APKs viejos en la calle).
  //   Los campos nuevos sí llevan el sufijo `Cents` para que nadie tenga que
  //   deducirlo. No "uniformes" ninguno de los dos grupos a pesos: romperías el
  //   contrato viejo o el nuevo.
  //
  //   Enteros SIEMPRE: se redondean con `pesosToCents`. Un `* 100` pelón sobre un
  //   importe de 2 decimales deja basura de float en ~13% de los casos
  //   (`0.55 * 100 === 55.00000000000001`), y el cliente no debe recibir eso en
  //   un campo de dinero.
  //
  // Opcionales porque son ADITIVOS: los clientes viejos los ignoran. El server
  // los llena SIEMPRE, en los cuatro caminos de retorno (cobro nuevo, reintento
  // idempotente, ganador de la carrera P2002, CAS perdida con llave propia).
  /** Lo que falta por cobrar de ESTA orden, en CENTAVOS enteros, clampeado a 0. */
  remainingBalanceCents?: number
  /** El estado en que quedó la orden tras este cobro. Sin unidad — no lo toques. */
  orderPaymentStatus?: 'PAID' | 'PARTIAL'
  /** Total recalculado (mercancía − descuento + cargo + propina), en CENTAVOS enteros. */
  orderTotalCents?: number
  /** Pagado acumulado de la orden, propinas incluidas, en CENTAVOS enteros. */
  totalPaidCents?: number
}

/**
 * Pesos (unidad interna) → centavos ENTEROS (unidad de esta frontera).
 *
 * El redondeo NO es opcional ni cosmético: `Number(decimal) * 100` sobre un
 * importe limpio de 2 decimales devuelve un no-entero en ~13% de los valores
 * (`0.55 * 100 === 55.00000000000001`, `0.29 * 100 === 28.999999999999996`), y
 * peor aún sobre el resultado de una RESTA (`133.45 - 50 → 83.44999999999999`).
 * Mismo criterio que ya usan los otros serializadores a centavos del namespace
 * `/mobile` (p. ej. `purchase-order.mobile.service.ts`) y equivalente al
 * `ROUND_HALF_UP` de `toStripeAmount` en la frontera de Stripe.
 */
function pesosToCents(pesos: number): number {
  return Math.round(pesos * 100)
}

/**
 * El cambio que le toca a un REINTENTO idempotente: lo que pidió el cliente (la
 * misma llave trae el mismo `amount`) menos lo que quedó registrado la primera
 * vez. Así el cajero ve el mismo cambio aunque la respuesta original se perdiera.
 */
function cambioDeReintento(pedidoCents: number, registrado: Prisma.Decimal | number | null | undefined): number {
  return Math.max(0, pedidoCents - pesosToCents(Number(registrado ?? 0)))
}

/**
 * Los cuatro campos de saldo, ya resueltos. Se arma una sola vez y se esparce
 * (`...snapshot`) en cada retorno para que ningún camino pueda olvidar uno.
 *
 * 🔴 CENTAVOS ENTEROS — ya convertidos, listos para serializar.
 */
interface OrderBalanceSnapshot {
  remainingBalanceCents: number
  orderPaymentStatus: 'PAID' | 'PARTIAL'
  orderTotalCents: number
  totalPaidCents: number
}

/**
 * Saldo REAL de la orden para los caminos que devuelven un pago que YA existía:
 * reintento con la misma `idempotencyKey`, ganador de la carrera P2002, y CAS
 * perdida cuando nuestro propio reintento anterior sí había commiteado.
 *
 * Se RELEE de la base a propósito, en vez de reusar la lectura de arriba: esos
 * dos últimos caminos corren DESPUÉS de la transacción, así que la lectura
 * inicial ya está vieja y el ganador movió el saldo. Un cliente reintentando
 * tiene que ver el MISMO saldo que vio el que sí entró — devolver 0 le diría
 * que la cuenta quedó saldada cuando todavía debe.
 */
async function readOrderBalanceSnapshot(venueId: string, orderId: string): Promise<Partial<OrderBalanceSnapshot>> {
  // 🔴 El `venueId` NO es decorativo: aislamiento de tenant es regla dura
  // (`.claude/rules/critical-warnings.md`). Hay un test que recorre TODAS las
  // lecturas de orden de este flujo y falla si a alguna le falta.
  const fresh = await prisma.order.findUnique({
    where: { id: orderId, venueId },
    select: { paymentStatus: true, total: true, paidAmount: true, remainingBalance: true },
  })

  // 🔴 AUSENTE ES HONESTO; CERO ES MENTIRA.
  //
  // Si la orden no se puede leer (se borró, no es de este venue, la lectura
  // falló) NO se inventa un snapshot: un `{remaining 0, status 'PARTIAL'}` le
  // pinta al cajero "falta por cobrar $0.00" sobre una cuenta que no existe —
  // y cero-con-PARTIAL es justo la combinación que rompe a un cliente que
  // ramifica por estado. Omitir los campos es exactamente lo que responde un
  // server viejo, así que el cliente cae solo a su fallback.
  if (!fresh) {
    logger.warn(`⚠️ [ORDER.MOBILE] No se pudo leer la orden ${orderId} para el saldo — se omiten los campos de saldo en la respuesta`)
    return {}
  }

  // Pesos mientras se calcula; a centavos sólo al construir la respuesta.
  const orderTotal = Number(fresh.total ?? 0)
  const totalPaid = Number(fresh.paidAmount ?? 0)
  // `remainingBalance` es la columna autoritativa; el resto sólo cubre filas
  // viejas que la tengan en null.
  const remaining = fresh.remainingBalance != null ? Number(fresh.remainingBalance) : orderTotal - totalPaid
  return {
    remainingBalanceCents: pesosToCents(Math.max(0, remaining)),
    // Sólo PAID es PAID. PENDING no debería existir aquí (hay un pago), pero si
    // apareciera, "falta dinero" es la lectura honesta y segura.
    orderPaymentStatus: fresh.paymentStatus === 'PAID' ? 'PAID' : 'PARTIAL',
    orderTotalCents: pesosToCents(orderTotal),
    totalPaidCents: pesosToCents(totalPaid),
  }
}

/**
 * Record a cash payment for an order (mobile-initiated)
 *
 * This is called directly from iOS when the user selects "Efectivo" payment.
 * No TPV terminal involved - payment goes directly to backend.
 *
 * @param venueId Venue ID (tenant isolation)
 * @param orderId Order ID
 * @param input Cash payment parameters
 * @returns Payment confirmation with receipt info
 */
/**
 * Una salida idempotente devuelve un cobro que YA existía. Si una caída se llevó el paso posterior de liberar la mesa,
 * se completa aquí (idempotente: sólo libera si ya no queda cuenta abierta). Nunca desmiente el pago.
 */
async function liberarMesaSiQuedoSaldada(venueId: string, tableId: string | null | undefined, orderId: string): Promise<void> {
  if (!tableId) return
  try {
    const { releaseTableIfSettled } = await import('../tpv/table.tpv.service')
    await releaseTableIfSettled(venueId, tableId)
  } catch (error) {
    logger.error('[ORDER.MOBILE] No se pudo completar la liberación de la mesa en un reintento (pago intacto)', {
      orderId,
      tableId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * La cuenta como la ve el núcleo justo después de tomar su candado (relectura + pagos previos, paso 3 del cobro).
 * De SÓLO LECTURA (A8, ruling 4): el gancho recibe los objetos vivos que el núcleo usa después —`fresh.version` en la
 * CAS, `previousPayments` en la aritmética—; un gancho que los mutara cambiaría el cobro sin que nadie lo viera.
 */
export interface CuentaBajoCandado {
  readonly fresh: Readonly<{
    id: string
    orderNumber: string
    paymentStatus: PaymentStatus
    subtotal: Prisma.Decimal
    discountAmount: Prisma.Decimal
    serviceChargeAmount: Prisma.Decimal
    status: OrderStatus
    contratoDePrecio: ContratoDePrecio
    taxAmount: Prisma.Decimal
    originSystem: OriginSystem
    version: number
    areaTicketCode: string | null
    tableId: string | null
  }>
  readonly previousPayments: ReadonlyArray<Readonly<{ amount: Prisma.Decimal; tipAmount: Prisma.Decimal; type: PaymentType | null }>>
}

/** Lo que el núcleo recibe ya resuelto FUERA de la transacción (una caída de settings jamás revierte un cobro). */
export interface AbonoEnTxContexto {
  venueId: string
  orderId: string
  effectiveStaffId: string | undefined
  marcarCocina: boolean
}

export interface AbonoEnTxEntrada {
  /** Lo SOLICITADO, en centavos enteros (la frontera de `payCashOrder`). */
  amountCents: number
  tipCents: number
  method: NonNullable<CashPaymentInput['method']>
  idempotencyKey?: string
  isOfflineReplay?: boolean
  externalSource?: string
  /** `ref`: lo resuelve `resolveTenderForCharge` (que rechaza los tenders de sistema). `resuelto`: ya lo resolvió el llamador. */
  tender: { ref: { id: string; revision: number } } | { resuelto: ResolvedTenderCharge } | null
  /** Corre bajo el candado de la Order, con la cuenta releída y sus pagos previos, ANTES de cualquier escritura. */
  trasCandadoDeOrden?: (tx: Prisma.TransactionClient, cuenta: CuentaBajoCandado) => Promise<void>
  dentroDeLaTx?: CashPaymentInput['dentroDeLaTx']
  /**
   * A quién atribuye la auditoría este abono (A8, ruling 3): `turno` va a `PAYMENT_WITHOUT_SHIFT.data.channel` y al aviso
   * de cobro sobre una cuenta con reembolsos; `reapertura`, a `ORDER_REOPENED_BY_CAPTURED_PAYMENT.data.canal`. Sin él,
   * los de `payCashOrder` de siempre, byte por byte (`'payCashOrder'` y `'payCashOrder:cola'` / `'payCashOrder:registro'`).
   */
  canal?: { turno: CapturedPaymentChannel; reapertura: string }
}

export interface AbonoEnTx {
  /** Caja OPEN al cobrar (leída en la misma transacción); el movimiento de efectivo va a ésa o a ninguna. */
  cajaAlCobrarId: string | null
  newPayment: any
  isFullyPaid: boolean
  areaTicketOrder: boolean
  areaTicketSessionId?: string
  tableId?: string | null
  postingId?: string | null
  /** Lo que de verdad se registró como pago (≤ saldo) y lo que sobró, en centavos. */
  aplicadoCents: number
  cambioCents: number
  /** Base de puntos en pesos, sin propinas. */
  loyaltyBase: number
  balance: OrderBalanceSnapshot
  /** El tender que usó el cobro: lo leen cajón, socket y respuesta FUERA de la transacción. */
  tenderResuelto: ResolvedTenderCharge | null
}

/**
 * El núcleo del abono (pasos 1–21 de hechos A § 1.3), extraído de `payCashOrder` SIN cambiar una regla (Tarea A7).
 * Recibe la transacción del llamador y no abre otra. Lo usan `payCashOrder` (efectivo, registro manual y la cola sin red
 * `PAY_CASH`) y `payGiftCardBalanceOnOrder` (cobro con saldo). Jerarquía de candados: vales v7 → Order → (gancho) → Shift.
 *
 * `reconciliationEnabled` va como parámetro SUELTO, no dentro de `ctx`: la guardia AST de turnos
 * (`paymentShiftClaim.callers.guard.test.ts`) sólo acepta el gate de la auditoría si lo puede seguir, de llamada en
 * llamada, hasta un `await resolvePaymentShiftReconciliationEnabled(…)`, y sigue parámetros posicionales, no propiedades
 * de un objeto. Cada llamador lo resuelve FUERA de la transacción, como siempre.
 */
export async function registrarAbonoEnTx(
  tx: Prisma.TransactionClient,
  ctx: AbonoEnTxContexto,
  entrada: AbonoEnTxEntrada,
  reconciliationEnabled: boolean,
): Promise<AbonoEnTx> {
  // Los mismos nombres que tenía el cuerpo dentro de `payCashOrder`: lo de abajo se movió tal cual.
  const { venueId, orderId, effectiveStaffId, marcarCocina } = ctx
  const amount = entrada.amountCents
  const tip = entrada.tipCents
  const paymentMethod = entrada.method
  const amountSolicitadoDecimal = amount / 100
  const tipDecimal = tip / 100
  const input = {
    idempotencyKey: entrada.idempotencyKey,
    isOfflineReplay: entrada.isOfflineReplay,
    externalSource: entrada.externalSource,
    dentroDeLaTx: entrada.dentroDeLaTx,
    tenderTypeId: entrada.tender && 'ref' in entrada.tender ? entrada.tender.ref.id : undefined,
    tenderRevision: entrada.tender && 'ref' in entrada.tender ? entrada.tender.ref.revision : undefined,
  }
  // Tarea A8 (ruling 3): quién registra el abono en la auditoría. Sin `canal`, `payCashOrder` como siempre.
  const canalDeTurno: CapturedPaymentChannel = entrada.canal?.turno ?? 'payCashOrder'
  const canalDeReapertura = entrada.canal?.reapertura ?? (input.isOfflineReplay ? 'payCashOrder:cola' : 'payCashOrder:registro')

  // 🔴 R13-1 (Codex r17 #1): el medio se resuelve ANTES de la sesión de vales (sólo lee; ningún candado), para que ella sepa si
  // el dinero ya se capturó. También va antes del saldo: decide si un exceso es cambio (una tarjeta o transferencia externa ya
  // capturada no produjo efectivo para devolver: recortarla escondería dinero real y rompería la conciliación) y si se admite
  // sobre una cuenta cancelada (Tarea 6a: depende de si es efectivo de cajón).
  const resolvedTender =
    entrada.tender && 'resuelto' in entrada.tender
      ? entrada.tender.resuelto
      : input.tenderTypeId != null && input.tenderRevision != null
        ? await resolveTenderForCharge(venueId, input.tenderTypeId, input.tenderRevision, tx, input.isOfflineReplay ? 'replay' : 'online')
        : null
  const effectiveMethod = resolvedTender?.method ?? paymentMethod
  const fundsFlow =
    resolvedTender?.fundsFlow ?? (effectiveMethod === 'CASH' ? PaymentFundsFlow.CASH_DRAWER : PaymentFundsFlow.EXTERNAL_RECORDED)
  const countsAsDrawerCash = paymentCountsAsDrawerCash({
    method: effectiveMethod,
    fundsFlow,
    tenderTypeId: resolvedTender?.tenderTypeId ?? null,
    tenderCountsAsCash: resolvedTender?.tenderCountsAsCash ?? null,
  })

  // 🔴 Founder 3-oct (núcleo del servidor; Codex r10 #2): el efectivo de cajón EN VIVO es un cobro NUEVO —la persona todavía
  // puede no cobrar—: sobre una cancelada ⇒ 400 con el texto del founder. Lo ya capturado (la cola; en vivo, una tarjeta ajena
  // o una transferencia ya hechas) nunca se rechaza por la cancelación: reabre una cuenta de Avoqado (una externa, sólo cuando
  // hoy salía de CANCELADA; Codex r13 #1). El importe, como hoy (el recorte y el «ya está pagada» son defectos previos del plan
  // de registro de cobros). Vales: su sesión decide.
  const cobroNuevo = esCobroNuevo({ enVivo: !input.isOfflineReplay, efectivoDeCajon: countsAsDrawerCash })

  // Vales v7 bloquean sesión → vales → orden ANTES del flujo monetario.
  // Para una orden normal devuelve null y el comportamiento queda idéntico.
  const areaTicketPayment = await import('./areaTicketV7.mobile.service')
  const lockedAreaCheckout = await areaTicketPayment.lockAreaTicketCheckoutForPayment(tx, {
    venueId,
    orderId,
    idempotencyKey: input.idempotencyKey,
    amount: new Prisma.Decimal(amountSolicitadoDecimal),
    method: paymentMethod,
    // 🔴 R12-1 / R13-1: lo ya capturado —la cola sin red, o en vivo una terminal ajena o una transferencia— no recibe 409 de la
    // sesión por su estado (cerrada, en conciliación o cancelada), como en la TPV (`cobroNuevo !== true`). El efectivo de cajón
    // en vivo sigue siendo cobro NUEVO.
    dineroCapturado: !cobroNuevo,
  })
  // Vales ya tomaron Order bajo su jerarquía session → tickets → Order;
  // para una orden normal este helper toma el primer lock. En ambos casos
  // lo siguiente conserva Order → Payment (si aplica) → Shift.
  await lockExistingOrderForPayment(tx, { venueId, orderId })

  // 1️⃣ RELECTURA DENTRO DE LA TRANSACCIÓN. Esta es la lectura que manda: la de
  //    arriba pudo quedar vieja mientras validábamos staff y turno.
  const fresh = await tx.order.findUnique({
    where: { id: orderId, venueId },
    select: {
      id: true,
      orderNumber: true,
      paymentStatus: true,
      subtotal: true,
      discountAmount: true,
      serviceChargeAmount: true,
      // P12 (Codex r2, r5): el saldo suma el IVA que va aparte y una cancelada no lo debe; sin estas tres el cobro
      // móvil daba por saldada con $100 una cuenta de $100 + $16.
      status: true,
      contratoDePrecio: true,
      taxAmount: true,
      // Tarea 6a: una cancelada de Avoqado se reabre con cualquier dinero ya capturado; una externa, sólo cuando hoy salía
      // de CANCELADA (Codex r12 #5, r13 #1).
      originSystem: true,
      version: true,
      areaTicketCode: true,
      tableId: true,
    },
  })
  if (!fresh) {
    throw new NotFoundError('Order not found')
  }

  // 2️⃣ VALIDACIÓN DENTRO DE LA TRANSACCIÓN (era el bug: estaba fuera).
  if (fresh.paymentStatus === 'PAID') {
    throw new BadRequestError('Order is already paid')
  }

  // 3️⃣ Suma acumulada de pagos previos — split-the-bill. Leída aquí dentro
  //    para que refleje al ganador de una carrera anterior.
  //
  // 🔴 `type` NO es decorativo: un reembolso vive como un `Payment` NEGATIVO
  // `type: REFUND` colgado de la MISMA orden, y sin ese campo la aritmética
  // no lo puede distinguir de un cobro. Se leen TODOS los COMPLETED (sin
  // filtrar por `type` en la consulta) porque la función pura necesita los
  // REFUND para reportar `refundState` — filtrarlos aquí los escondería.
  const previousPayments = await tx.payment.findMany({
    where: { orderId, status: 'COMPLETED' },
    select: { amount: true, tipAmount: true, type: true },
  })

  // Tarea A7: el cobro con saldo bloquea aquí sus sobres (Order → sobres → turno) y valida el monto contra el saldo.
  // En `payCashOrder` no viene: no cambia nada.
  await entrada.trasCandadoDeOrden?.(tx, { fresh, previousPayments })

  // 🔴 La aritmética canónica, ya no una copia local en FLOAT.
  //
  // Esta función se extrajo justo de aquí y este camino se había quedado
  // con su copia. Volver a llamarla cierra dos cosas de golpe: la deriva
  // entre canales, y el defecto que este trabajo ataca — un reembolso NO
  // reabre saldo, porque `computeOrderBalance` excluye los `type: REFUND`
  // de lo pagado y los lleva en su propio carril (`refundState`).
  //
  // Las reglas que ya aplicaba y siguen intactas (hay tests que las fijan):
  // mercancía clampada a 0 ANTES de sumar cargos y propina —un
  // `discountAmount` mayor que el subtotal existe de verdad en la base y
  // sin el clamp la venta escribía un `Order.total` NEGATIVO que RESTA del
  // corte del día (ORD-1779465117373, 2026-08-09)—, el cargo por servicio
  // dentro del total, y la tolerancia de un centavo para darla por saldada.
  // Lo único que cambia es que la suma va en `Decimal` y no en float.
  // 🔴 Un cobro MAYOR al saldo no es una venta mayor: es CAMBIO. Medido el
  // 2026-09-01: `amount: 3000` sobre una cuenta de $25 registraba un Payment de
  // $30.00 (y `999999999999`, uno de $9,999,999,999.99) e inflaba ventas y
  // VenueTransaction. La app manda siempre el total exacto y calcula el cambio
  // en el aparato, así que esto sólo lo abre un cliente raro por API — por eso
  // el aviso de abajo. Se registra como máximo lo que la cuenta DEBE (sin
  // propina: la propina va aparte y no se toca) y el resto regresa en la
  // respuesta como `changeCents`. El pago manual del dashboard rechaza el
  // exceso con 400; aquí no se bloquea porque el dinero sí entró al cajón.
  // (El medio y `cobroNuevo` se resuelven arriba, antes de la sesión de vales: R13-1.)
  if (cobroNuevo && claseDeEstado(fresh.status) === 'CANCELADA') {
    // Codex r13 #2: antes del rechazo, la identidad del cobro otra vez, BAJO EL CANDADO. Si su llave ya tiene un Payment —el
    // ganador de una carrera que la consulta rápida de arriba no vio—, sale por la red de la carrera (P2002, abajo).
    await salirSiLaLlaveYaTienePago(tx, { venueId, orderId, idempotencyKey: input.idempotencyKey })
    rechazarCobroNuevoSobreCancelada(fresh.status)
  }
  // Codex r13 #1: ¿lo cobrado cubre lo que la cuenta debe TAL COMO ESTÁ? Es lo que hoy decide el cierre. Con el importe bruto:
  // el recorte al saldo (abajo) da el mismo `isFullyPaid`.
  const cubreComoCancelada = computeOrderBalance(fresh, [
    ...previousPayments,
    { amount: amount / 100, tipAmount: tipDecimal, type: 'REGULAR' },
  ]).isFullyPaid
  // El `staffId` ya está validado contra el negocio (`validateStaffVenue`): la bitácora lo amarra por FK y un id inválido
  // revertiría el cobro. Vales: lo que los excluye es la SESIÓN v7 (`lockedAreaCheckout`): su finalización decide y
  // rechaza una orden cancelada (409 `CHECKOUT_ORDER_NOT_PAYABLE`, todo se revierte). NO `areaTicketCode`: ése sólo lo
  // escriben los vales v6, que no tienen sesión y se cobran como cualquier cuenta (revisión de 6a-2, I-1).
  const estado =
    !cobroNuevo && !lockedAreaCheckout
      ? await reabrirSiRecibeDinero(tx, {
          venueId,
          orderId,
          status: fresh.status,
          originSystem: fresh.originSystem,
          cobrado: new Prisma.Decimal(amount + tip).dividedBy(100),
          cubreComoCancelada,
          canal: canalDeReapertura,
          idempotencyKey: input.idempotencyKey ?? null,
          staffId: effectiveStaffId ?? null,
        })
      : fresh.status
  // La cuenta con el estado con el que RECIBE este dinero: los dos saldos y el cierre se calculan con él. La reapertura no toca
  // `version`, así que la CAS de abajo sigue amarrada a la versión leída.
  const cuenta = { ...fresh, status: estado }

  // Con devoluciones previas el saldo NO revive (`orderBalance.ts`), pero un
  // cobro nuevo sobre esa cuenta sí se registra (`payCashOrder.refund.test.ts`):
  // lo devuelto se puede volver a cobrar. Por eso el tope es saldo + devuelto;
  // sin devoluciones, es exactamente el saldo.
  const saldoAntes = computeOrderBalance(cuenta, previousPayments)
  // Recheck after the Order lock: the zero-payment preflight balance can be stale.
  if (amount === 0 && tip === 0 && saldoAntes.remainingBalance.greaterThan(0.005)) {
    throw new BadRequestError(
      `Esta cuenta debe ${saldoAntes.remainingBalance.toFixed(2)}. Un cobro en $0 sólo cierra cuentas cortesiadas al 100%.`,
    )
  }
  const saldoCents = Math.max(0, pesosToCents(saldoAntes.remainingBalance.plus(saldoAntes.refundedAmount).toNumber()))
  const cambioCents = countsAsDrawerCash ? Math.max(0, amount - saldoCents) : 0
  const aplicadoCents = amount - cambioCents
  const amountDecimal = aplicadoCents / 100

  if (resolvedTender && !resolvedTender.tenderCaptureTip && tipDecimal > 0) {
    throw new BadRequestError(`El tipo de pago "${resolvedTender.tenderLabel}" no acepta propina.`)
  }

  const balance = computeOrderBalance(cuenta, [...previousPayments, { amount: amountDecimal, tipAmount: tipDecimal, type: 'REGULAR' }])

  // No se BLOQUEA nada: el dinero es real y registrarlo siempre gana. Pero un
  // cobro que aterriza sobre una cuenta con devoluciones merece una mirada
  // humana, así que queda un rastro greppable — MISMO token en los cuatro
  // canales de cobro.
  if (balance.refundState !== 'NONE') {
    logger.warn('⚠️ [Reembolso] cobro sobre una cuenta con reembolsos — el saldo NO los cuenta, revisar', {
      orderId,
      venueId,
      channel: canalDeTurno,
      refundState: balance.refundState,
      refundedAmount: balance.refundedAmount.toFixed(2),
    })
  }

  const totalTip = balance.tipAmount.toNumber()
  const newTotal = balance.total.toNumber()
  const totalPaidIncludingTip = balance.paidAmount.toNumber()
  const remainingAfterPayment = balance.remainingBalance.toNumber()
  // Founder 3-oct: una cancelada nunca queda saldada. Con lo que debía ya salió de CANCELADA arriba; aquí sólo llega cancelada
  // la orden de una sesión de vales v7 (su finalización la rechaza y revierte todo) o una externa que no cubre (como hoy, no se
  // cierra).
  const isFullyPaid = balance.isFullyPaid && cierreAutomaticoPermitido(estado)

  // 4️⃣ TRANSICIÓN CONDICIONAL (CAS). `updateMany` con la versión leída: si otro
  //    dispositivo cobró entre la relectura y este write, PostgreSQL reevalúa el
  //    WHERE contra la fila nueva, no coincide, y count = 0. Nada se escribió.
  const transition = await tx.order.updateMany({
    where: { id: orderId, venueId, version: fresh.version, paymentStatus: { in: ['PENDING', 'PARTIAL'] } },
    data: {
      paymentStatus: isFullyPaid ? 'PAID' : 'PARTIAL',
      // 🔴 Un abono PARCIAL no toca `Order.status`. Antes escribía
      // `PENDING`, o sea que una comanda ya `CONFIRMED`/`PREPARING`
      // RETROCEDÍA de etapa porque el cliente pagó la mitad — cobrar no es
      // un evento de cocina. `status` es el interruptor "¿la cuenta sigue
      // abierta?" (las listas de cuentas abiertas y el plano de mesas
      // filtran por él); el dinero se lee de `paymentStatus`. Un cobro sólo
      // puede AVANZARLO a COMPLETED cuando la cuenta queda saldada.
      // (`payment.tpv.service`, `manualPayment.service` y el webhook de
      // cripto ya se comportaban así.)
      ...(isFullyPaid ? { status: 'COMPLETED' as const } : {}),
      ...(isFullyPaid ? { loyaltyEligibleAt: new Date(), loyaltyStaffId: effectiveStaffId } : {}),
      ...(isFullyPaid && marcarCocina ? { kitchenPendingAt: new Date() } : {}),
      paidAmount: new Prisma.Decimal(totalPaidIncludingTip),
      remainingBalance: Math.max(0, remainingAfterPayment),
      tipAmount: totalTip,
      total: new Prisma.Decimal(newTotal),
      splitType: 'FULLPAYMENT',
      version: { increment: 1 },
      // Vales por área: al quedar pagada, la cuenta deja de estar reclamada por
      // la caja. El claim ya no significa nada y arrastrarlo confundiría la
      // pantalla de "vales pendientes".
      ...(isFullyPaid && fresh.areaTicketCode ? { claimedByTerminalId: null, claimedAt: null } : {}),
    },
  })
  if (transition.count === 0) {
    const conflict: any = new Error('PAY_CASH_CAS_LOST')
    conflict.code = 'PAY_CASH_CAS_LOST'
    throw conflict
  }

  // La orden ya ganó su CAS; ahora el cobro reclama el turno dentro de
  // esta misma tx y antes de crear el Payment. Si el cierre ganó, el
  // Payment queda sin turno y se audita abajo, sin tocar el corte firmado.
  const shiftAmount = new Prisma.Decimal(amountDecimal)
  const shiftTip = new Prisma.Decimal(tipDecimal)
  const shiftClaim = await claimShiftForCapturedPayment(tx, {
    venueId,
    amountPesos: shiftAmount,
    tipPesos: shiftTip,
    // La Order cuenta al primer cobro canónico; dos abonos del mismo
    // ticket nunca cuentan dos órdenes.
    incrementTotalOrders: !previousPayments.some(payment => payment.type !== 'REFUND'),
  })

  // 5️⃣ El Payment se crea DESPUÉS de ganar la transición. Si la CAS falla, este
  //    insert nunca ocurre — que es exactamente lo que evita el segundo cobro.
  const paymentSource = countsAsDrawerCash ? 'APP' : 'OTHER'
  const externalSource = countsAsDrawerCash ? null : input.externalSource?.trim()?.slice(0, 50) || null

  const newPayment = await tx.payment.create({
    data: {
      venueId,
      orderId,
      amount: amountDecimal,
      tipAmount: tipDecimal,
      method: resolvedTender?.method ?? paymentMethod,
      status: 'COMPLETED',
      type: 'REGULAR',
      splitType: 'FULLPAYMENT',
      source: paymentSource,
      externalSource,
      fundsFlow: resolvedTender ? resolvedTender.fundsFlow : fundsFlow,
      processedById: effectiveStaffId,
      shiftId: shiftClaim.shiftId,
      // 🛡️ Llave de idempotencia: el índice único [venueId, idempotencyKey]
      // hace que un reintento del cliente choque (P2002) o se atrape arriba,
      // nunca cree un segundo pago.
      idempotencyKey: input.idempotencyKey ?? null,
      // Cash payments have no card data or merchant account
      merchantAccountId: null,
      feePercentage: 0,
      feeAmount: 0,
      netAmount: amountDecimal + tipDecimal,
      // Snapshots inmutables del tender (todos resueltos por el server). Editar
      // el catálogo mañana NO reinterpreta este cobro.
      tenderTypeId: resolvedTender?.tenderTypeId,
      tenderRevision: resolvedTender?.tenderRevision,
      tenderLabel: resolvedTender?.tenderLabel,
      tenderCountsAsCash: resolvedTender?.tenderCountsAsCash,
      tenderCaptureTip: resolvedTender?.tenderCaptureTip,
      tenderSatFormaPago: resolvedTender?.tenderSatFormaPago,
      tenderCommissionPercent: resolvedTender?.tenderCommissionPercent,
      tenderCommissionAmount: resolvedTender
        ? computeTenderCommission(resolvedTender.tenderCommissionPercent, new Prisma.Decimal(amountDecimal))
        : undefined,
    },
  })

  await recordPendingPaymentShiftReconciliation(tx, {
    reconciliationEnabled,
    claim: shiftClaim,
    venueId,
    paymentId: newPayment.id,
    orderId,
    staffId: effectiveStaffId ?? null,
    channel: canalDeTurno,
    amountPesos: shiftAmount,
    tipPesos: shiftTip,
  })

  // Create VenueTransaction for financial tracking
  await tx.venueTransaction.create({
    data: {
      venueId,
      paymentId: newPayment.id,
      type: 'PAYMENT',
      grossAmount: amountDecimal + tipDecimal,
      feeAmount: 0,
      netAmount: amountDecimal + tipDecimal,
      status: 'SETTLED', // Cash is immediately settled
    },
  })

  // Create payment allocation
  await tx.paymentAllocation.create({
    data: {
      paymentId: newPayment.id,
      orderId,
      amount: amountDecimal,
    },
  })

  const areaFinalization = await areaTicketPayment.finalizeAreaTicketPaymentInTransaction(tx, {
    venueId,
    orderId,
    paymentId: newPayment.id,
    fullyPaid: isFullyPaid,
    staffId: effectiveStaffId,
    locked: lockedAreaCheckout,
  })

  // 🔴 Posting durable (fase 2, auditoría 2026-08-12): el "vale de
  // deducción" nace EN ESTA transacción — si el proceso muere después del
  // commit y antes de deducir, queda un posting PENDING visible que el
  // job de respaldo reaplica, en vez de una deducción perdida invisible.
  // Área-tickets: su propia finalización ya dedujo y dejó su vale SKIPPED
  // (`AREA_TICKET_TRANSACTIONAL`, R10-1) en esta misma transacción — aquí no se crea otro.
  let postingId: string | null = null
  if (isFullyPaid && !areaFinalization.areaTicketOrder) {
    const { createSalePostingInTx } = await import('@/services/inventory/inventoryPosting.service')
    const txItems = await tx.orderItem.findMany({
      where: { orderId },
      include: { modifiers: { include: { modifier: true } } },
    })
    const posting = await createSalePostingInTx(tx, {
      venueId,
      orderId,
      items: txItems as any,
      staffId: effectiveStaffId,
    })
    postingId = posting?.id ?? null
    // R8 (tarjetas de regalo): la cuenta de tarjetas que queda pagada activa sus sobres en ESTA transacción.
    await activarSobresDeCuentaPagadaEnTx(tx, { venueId, orderId, staffId: effectiveStaffId ?? null, items: txItems })
  }

  // FT-GRAVES S-EF (medido el 8-oct): el MISMO gancho de comisión que la terminal, con el dinero, en esta transacción. Sin
  // él, este cobro y la cola sin red `PAY_CASH` (que lo reutiliza) no comisionaban. Un efecto por cobro: no se duplica.
  await enqueuePaymentCommissionInTx(tx, newPayment.id)
  // Referido: obligación durable con el dinero, como la terminal (`payment.tpv.service.ts`). Si el proceso muere antes
  // de la llamada directa de abajo, el worker de efectos la completa; el consumidor deduplica.
  if (isFullyPaid) {
    await enqueuePaymentEffect(tx, {
      venueId,
      paymentId: newPayment.id,
      orderId,
      kind: 'REFERRAL',
      dedupeKey: 'referral:' + orderId + ':v1',
      payload: { expectsSettlement: true },
    })
  }
  // La caja ABIERTA al cobrar se fija aquí: el movimiento de efectivo va a ESA sesión y sólo si sigue abierta. Una caja
  // abierta DESPUÉS del cobro (cierre + apertura a media transacción) no se lo queda: lo repone el conciliador.
  const cajaAlCobrar = await tx.cashDrawerSession.findFirst({
    where: { venueId, status: 'OPEN', openedAt: { lte: newPayment.createdAt } },
    select: { id: true },
  })
  await input.dentroDeLaTx?.(tx, { orderId, paymentId: newPayment.id })

  return {
    cajaAlCobrarId: cajaAlCobrar?.id ?? null,
    newPayment,
    isFullyPaid,
    aplicadoCents,
    cambioCents,
    areaTicketOrder: areaFinalization.areaTicketOrder,
    areaTicketSessionId: areaFinalization.sessionId,
    tableId: fresh.tableId,
    postingId,
    // 🔴 Los MISMOS valores que se acaban de persistir arriba (que van en
    // pesos), no un recálculo: la respuesta no puede contradecir a la
    // base. `pesosToCents` es la única conversión, ya en la frontera.
    balance: {
      remainingBalanceCents: pesosToCents(Math.max(0, remainingAfterPayment)),
      orderPaymentStatus: isFullyPaid ? 'PAID' : 'PARTIAL',
      orderTotalCents: pesosToCents(newTotal),
      totalPaidCents: pesosToCents(totalPaidIncludingTip),
    },
    loyaltyBase: Math.max(0, newTotal - totalTip),
    tenderResuelto: resolvedTender,
  }
}

export async function payCashOrder(venueId: string, orderId: string, input: CashPaymentInput): Promise<CashPaymentResponse> {
  const amount = input.amount
  const tip = input.tip || 0

  logger.info(`💵 [ORDER.MOBILE] Recording cash payment | venue=${venueId} | order=${orderId} | amount=${amount} cents | tip=${tip} cents`)
  // D5 (mesas40): sólo se GRITA. Ni recorte ni 400: recortar el cambio altera lo registrado (aplicado = recibido −
  // cambio) y un rechazo perdería cobros que YA ocurrieron fuera (tarjeta de una terminal ajena, transferencia). El
  // tope de verdad va en el teclado del aparato, antes de confirmar; pasar de él aquí es un cliente raro o la API cruda.
  if (amount > MAX_TERMINAL_PAYMENT_CENTS) {
    logger.error('🚨 [Sobrepago] payCash recibió más que el tope del teclado; se registra exacto como siempre', {
      venueId,
      orderId,
      amountCents: amount,
      topeCents: MAX_TERMINAL_PAYMENT_CENTS,
      method: input.method ?? 'CASH',
      idempotencyKey: input.idempotencyKey ?? null,
    })
  }

  // Find and validate order
  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
    select: {
      id: true,
      orderNumber: true,
      paymentStatus: true,
      subtotal: true,
      discountAmount: true,
      serviceChargeAmount: true,
      total: true,
      remainingBalance: true,
      venueId: true,
      tableId: true,
      areaTicketCheckoutSession: { select: { id: true } },
      // Lealtad: el cliente heredado es el respaldo cuando no hay OrderCustomer.
      customerId: true,
      customer: { select: { id: true, firstName: true, lastName: true } },
    },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }
  if (order.areaTicketCheckoutSession && !input.idempotencyKey) {
    throw new BadRequestError('Las ventas con vales requieren idempotencyKey. Reintenta el mismo pago con una llave estable.')
  }

  // 🔴 Cobro en $0 — cerrar una cuenta cortesiada al 100%.
  //
  // Una cuenta con artículos cuyo total quedó en 0 (cortesía completa, o un
  // descuento que se come el total) NO tenía forma de cerrarse: `compWholeOrder`
  // pone los artículos en 0 pero no toca `paymentStatus`, y este endpoint
  // rechazaba `amount = 0`. Resultado: la mesa se quedaba ocupada para siempre.
  //
  // Anular la cuenta NO es equivalente y por eso no sirve como salida: el
  // producto SÍ salió del almacén y la cortesía tiene que quedar registrada
  // como venta en $0, no desaparecer del reporte.
  //
  // El 0 sólo se acepta si el saldo REALMENTE es 0. Si no, es un intento de
  // cerrar gratis una cuenta que sí debe dinero.
  if (amount === 0 && tip === 0) {
    const balancePendiente = Number(order.remainingBalance ?? order.total ?? 0)
    if (balancePendiente > 0.005) {
      throw new BadRequestError(`Esta cuenta debe ${balancePendiente.toFixed(2)}. Un cobro en $0 sólo cierra cuentas cortesiadas al 100%.`)
    }
  }

  // 🛡️ IDEMPOTENCIA — defensa PRINCIPAL contra doble-cobro en reintentos del
  // outbox/cola offline. El guard `paymentStatus === 'PAID'` de abajo SOLO
  // protege pagos COMPLETOS; un pago PARCIAL re-encolado dejaría la orden en
  // PARTIAL y crearía un segundo Payment. La llave dedup atrapa AMBOS casos.
  // Mismo patrón que recordFastPayment (payment.tpv.service.ts:1390).
  if (input.idempotencyKey) {
    const existingByKey = await prisma.payment.findUnique({
      where: { venueId_idempotencyKey: { venueId, idempotencyKey: input.idempotencyKey } },
      include: { receipts: RECIBO_CANONICO },
    })
    if (existingByKey) {
      assertIdempotentPaymentOrder(existingByKey, orderId)
      logger.info(
        `🔄 [ORDER.MOBILE] Reintento idempotente detectado (key=${input.idempotencyKey}) — devuelvo el pago existente ${existingByKey.id}`,
      )
      await liberarMesaSiQuedoSaldada(venueId, order.tableId, orderId)
      return {
        paymentId: existingByKey.id,
        orderId,
        orderNumber: order.orderNumber,
        // 🔴 `pesosToCents`, no un `* 100` pelón. Reconstruir estos dos desde el
        // Decimal guardado dejaba ruido de float en el 13% de los importes, y en
        // el 6.6% POR DEBAJO del entero (`19.99 → 1998.9999999999998`): un cliente
        // que trunca al parsear leía $19.98 sobre un cobro de $19.99, y un decoder
        // estricto lanzaba excepción y perdía el reintento entero. Redondear no
        // cambia nombre, tipo ni unidad — sólo devuelve el entero que siempre se
        // quiso devolver, y nadie puede depender del ruido.
        amount: pesosToCents(Number(existingByKey.amount)),
        tipAmount: pesosToCents(Number(existingByKey.tipAmount)),
        changeCents: cambioDeReintento(amount, existingByKey.amount),
        // El método REAL del pago que ya existe: devolver 'CASH' fijo haría
        // que el reintento de un cobro con tarjeta se reportara como efectivo.
        method: existingByKey.method as CashPaymentResponse['method'],
        status: 'COMPLETED',
        digitalReceipt: existingByKey.receipts?.[0]
          ? mapDigitalReceiptResponse(existingByKey.receipts[0], await resolveAutofacturaAvailable(orderId))
          : null,
        // El saldo REAL de la orden ahora mismo, no 0: quien reintenta la parte 1
        // de un cobro dividido tiene que seguir viendo lo que falta.
        ...(await readOrderBalanceSnapshot(venueId, orderId)),
      }
    }
  }

  // NOTA: el guard "ya está pagada" NO se evalúa aquí sobre esta lectura. Se evalúa
  // DENTRO de la transacción, contra una relectura fresca (ver abajo). Esta lectura
  // sólo sirve para el 404 y para el `orderNumber` de la respuesta idempotente.

  // Cómo pagó el cliente. Sin `method` (clientes viejos) sigue siendo efectivo.
  const paymentMethod = input.method ?? 'CASH'
  // 🔴 El tender se resuelve DENTRO de la transacción, pero el cajón, el socket y la
  // respuesta corren FUERA. Sin sacarlo por un holder, todos ellos veían el fallback
  // 'CASH' y un cobro de Uber Eats creaba un CASH_SALE falso: el corte acusaba un
  // faltante del tamaño de la venta. Mismo patrón de holder que `postingState`.
  const tenderState: { resolved: import('../dashboard/tenderType.dashboard.service').ResolvedTenderCharge | null } = {
    resolved: null,
  }
  const effectiveStaffId = await validateStaffVenue(input.staffId, venueId)
  // El gate se resuelve una sola vez y FUERA de la transacción monetaria: una
  // caída de settings jamás revierte un Payment real.
  const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venueId)
  // Etapa 3 del KDS: ¿esta venta necesita comanda de pantalla? FUERA de la transacción (nunca tumba un cobro);
  // la marca viaja en la MISMA escritura que salda la orden.
  const marcarCocina = await debeMarcarCocina(venueId, { orderId })

  // Centavos → pesos para el post-commit. Lo SOLICITADO contra lo registrado se decide en el núcleo (`aplicadoCents`).
  const tipDecimal = tip / 100

  // ══════════════════════════════════════════════════════════════════════════════
  // 🔴 COBRO ATÓMICO — arregla un doble-cobro que YA estaba desplegado.
  // ══════════════════════════════════════════════════════════════════════════════
  //
  // Antes: `paymentStatus` se leía FUERA de la transacción y el `Payment` se creaba
  // DENTRO. El único guard real era el índice `[venueId, idempotencyKey]`, que sólo
  // atrapa dos requests con la MISMA llave. Dos dispositivos generan llaves
  // DISTINTAS, ambos leen PENDING, ambos crean un pago, y `paidAmount > total` sin
  // que nadie se entere hasta el corte.
  //
  // Era estrecho mientras la orden nacía al pagar en UN dispositivo. Con la cuenta
  // compartida entre áreas deja de serlo: 4 dispositivos conocen el mismo `orderId`
  // POR DISEÑO, y las órdenes sin mesa no tienen guard de propiedad.
  //
  // Ahora: lectura + validación + transición van DENTRO de la transacción, y la
  // transición es una CAS sobre `version` (`updateMany` que devuelve count 0 si
  // alguien más ganó). Mismo patrón que `addItemsToOrder` en order.tpv.service.ts.
  //
  // ── Por qué un REINTENTO acotado y no un 409 seco ────────────────────────────
  // Un 409 al perdedor rompería el split legítimo: dos meseros cobrando mitad y
  // mitad a la vez. Al reintentar, el perdedor RELEE el estado ya commiteado por el
  // ganador y recalcula sobre él:
  //   · si la orden quedó PAID  → "Order is already paid" (UN solo Payment) ✅
  //   · si quedó PARTIAL        → cobra el restante real, no el que leyó primero ✅
  // Tres intentos: la contención real es de 2-4 dispositivos, no de cientos.
  const MAX_PAYMENT_CAS_ATTEMPTS = 3
  const tenderRef =
    input.tenderTypeId != null && input.tenderRevision != null ? { ref: { id: input.tenderTypeId, revision: input.tenderRevision } } : null
  let paymentResult: AbonoEnTx | undefined

  for (let attempt = 1; attempt <= MAX_PAYMENT_CAS_ATTEMPTS; attempt++) {
    try {
      paymentResult = await prisma.$transaction(
        async tx =>
          await registrarAbonoEnTx(
            tx,
            { venueId, orderId, effectiveStaffId, marcarCocina },
            {
              amountCents: amount,
              tipCents: tip,
              method: paymentMethod,
              idempotencyKey: input.idempotencyKey,
              isOfflineReplay: input.isOfflineReplay,
              externalSource: input.externalSource,
              tender: tenderRef,
              dentroDeLaTx: input.dentroDeLaTx,
            },
            reconciliationEnabled,
          ),
        ORDER_LOCK_WAIT_BUDGET,
      )
      break // ganamos la transición
    } catch (err: any) {
      // 🛡️ Carrera IDEMPOTENTE: si dos requests con la MISMA idempotencyKey pasan
      // el findUnique de arriba (ninguna había commiteado aún), la segunda choca
      // en el índice único (P2002); la atrapamos y devolvemos el pago ganador —
      // nunca creamos un segundo Payment. ESTE CAMINO SE CONSERVA TAL CUAL.
      // Codex r13 #2 (Tarea 6a): `CobroYaRegistrado` es el mismo caso visto ANTES de intentar crear —bajo el candado, la llave ya
      // tenía su Payment—, así que sale por aquí y devuelve ese pago en vez de un 400 por una cuenta cancelada después.
      if ((err?.code === 'P2002' || err instanceof CobroYaRegistrado) && input.idempotencyKey) {
        const winner = await prisma.payment.findUnique({
          where: { venueId_idempotencyKey: { venueId, idempotencyKey: input.idempotencyKey } },
          include: { receipts: RECIBO_CANONICO },
        })
        if (winner) {
          assertIdempotentPaymentOrder(winner, orderId)
          logger.info(`🔄 [ORDER.MOBILE] Carrera idempotente (P2002) — devuelvo el pago ganador ${winner.id}`)
          await liberarMesaSiQuedoSaldada(venueId, order.tableId, orderId)
          return {
            paymentId: winner.id,
            orderId,
            orderNumber: order.orderNumber,
            // Enteros, igual que el camino idempotente de arriba.
            amount: pesosToCents(Number(winner.amount)),
            tipAmount: pesosToCents(Number(winner.tipAmount)),
            changeCents: cambioDeReintento(amount, winner.amount),
            method: winner.method as CashPaymentResponse['method'],
            status: 'COMPLETED',
            digitalReceipt: winner.receipts?.[0]
              ? mapDigitalReceiptResponse(winner.receipts[0], await resolveAutofacturaAvailable(orderId))
              : null,
            // Relectura obligada: el ganador ya movió el saldo y la lectura de
            // arriba (previa a la transacción) quedó vieja.
            ...(await readOrderBalanceSnapshot(venueId, orderId)),
          }
        }
        // `CobroYaRegistrado` no es un AppError: sin esto saldría como 500. Bajo el candado el pago existía y ahora no se
        // puede releer; el cliente reintenta con la MISMA llave y cae en el camino idempotente o en la regla de la cuenta.
        if (err instanceof CobroYaRegistrado) {
          logger.error('🚨 [ORDER.MOBILE] La llave tenía un pago bajo el candado y ya no se puede releer', {
            venueId,
            orderId,
            paymentId: err.paymentId,
            idempotencyKey: input.idempotencyKey,
          })
          throw new ConflictError('No se pudo confirmar el cobro con esta llave. Vuelve a intentar.', 'ORDER_PAYMENT_CONFLICT')
        }
      }

      // Perdimos la CAS: otro dispositivo cobró esta orden mientras calculábamos.
      // Reintentamos releyendo — el propio guard "ya está pagada" de la relectura
      // resuelve el caso del doble cobro completo.
      if (err?.code === 'PAY_CASH_CAS_LOST') {
        // 🛡️ Antes de reintentar, ¿existe ya un pago con NUESTRA llave? Puede pasar
        // si nuestro propio reintento anterior sí commiteó y la respuesta se perdió.
        if (input.idempotencyKey) {
          const mine = await prisma.payment.findUnique({
            where: { venueId_idempotencyKey: { venueId, idempotencyKey: input.idempotencyKey } },
            include: { receipts: RECIBO_CANONICO },
          })
          if (mine) {
            assertIdempotentPaymentOrder(mine, orderId)
            await liberarMesaSiQuedoSaldada(venueId, order.tableId, orderId)
            return {
              paymentId: mine.id,
              orderId,
              orderNumber: order.orderNumber,
              // Enteros, igual que los otros dos caminos idempotentes.
              amount: pesosToCents(Number(mine.amount)),
              tipAmount: pesosToCents(Number(mine.tipAmount)),
              changeCents: cambioDeReintento(amount, mine.amount),
              method: mine.method as CashPaymentResponse['method'],
              status: 'COMPLETED',
              digitalReceipt: mine.receipts?.[0]
                ? mapDigitalReceiptResponse(mine.receipts[0], await resolveAutofacturaAvailable(orderId))
                : null,
              // Igual que arriba: nuestro propio commit anterior ya movió el saldo.
              ...(await readOrderBalanceSnapshot(venueId, orderId)),
            }
          }
        }
        if (attempt < MAX_PAYMENT_CAS_ATTEMPTS) {
          logger.warn(
            `⚠️ [ORDER.MOBILE] Carrera de cobro en la orden ${orderId} (intento ${attempt}/${MAX_PAYMENT_CAS_ATTEMPTS}) — releo y recalculo`,
          )
          continue
        }
        // Agotados los intentos: 409 explícito. El cliente reintenta con la MISMA
        // llave y cae en el camino idempotente, o descubre que ya está pagada.
        throw new ConflictError(
          'La cuenta cambió mientras se cobraba (otro dispositivo la está cobrando). Vuelve a intentar.',
          'ORDER_PAYMENT_CONFLICT',
        )
      }
      throw err
    }
  }

  if (!paymentResult) {
    // Inalcanzable: el bucle o devuelve, o asigna, o lanza. Guard para el tipo.
    throw new ConflictError('No se pudo registrar el cobro. Vuelve a intentar.', 'ORDER_PAYMENT_CONFLICT')
  }
  // El tender lo resolvió el núcleo; el cajón, los sockets y la respuesta lo leen de este holder, como antes.
  tenderState.resolved = paymentResult.tenderResuelto
  const { newPayment: payment, isFullyPaid: orderFullyPaid, postingId, balance, aplicadoCents, cambioCents, loyaltyBase } = paymentResult
  // Los payloads de abajo (cajón, sockets, respuesta) llevan lo REGISTRADO, no lo solicitado.
  const amountDecimal = aplicadoCents / 100
  if (cambioCents > 0) {
    logger.warn('[ORDER.MOBILE] payCash: el monto excede el saldo; se registra el saldo y el resto es cambio', {
      venueId,
      orderId,
      amountCents: amount,
      aplicadoCents,
      cambioCents,
    })
  }

  logger.info(`✅ [ORDER.MOBILE] Cash payment recorded | paymentId=${payment.id} | order=${order.orderNumber}`)

  // Como la terminal: el plano se libera después del commit y nunca desmiente un pago aprobado.
  if (orderFullyPaid && !paymentResult.areaTicketOrder && paymentResult.tableId) {
    try {
      const { releaseTableIfSettled } = await import('../tpv/table.tpv.service')
      await releaseTableIfSettled(venueId, paymentResult.tableId)
    } catch (error) {
      logger.error('[ORDER.MOBILE] Post-payment table release failed (payment unaffected)', {
        orderId,
        tableId: paymentResult.tableId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // 🔴 EL CAJÓN SUMA LA VENTA (simétrico con el PAY_OUT del reembolso).
  //
  // Este servicio es el punto por el que pasa TODO cobro manual del POS móvil: la
  // ruta en línea y la reproducción del outbox offline (intent `PAY_CASH` →
  // `applyPayCash` → aquí). Un solo enganche cubre los dos.
  //
  // Va DESPUÉS del commit y no dentro de la transacción a propósito: una falla del
  // cajón jamás puede revertir un cobro. `postCashSaleToDrawer` no lanza —devuelve
  // el resultado— y es idempotente por `localId` derivado del paymentId, así que un
  // replay del outbox no duplica el movimiento. El `catch` es cinturón sobre tirantes.
  //
  // Los retornos idempotentes de arriba (llave repetida, ganador de la carrera P2002)
  // NO llaman aquí a propósito: el movimiento lo creó la llamada que sí cobró.
  // Sin caja abierta al cobrar no hay movimiento: como el conciliador, una venta sin caja no entra a la que se abra después.
  if (paymentResult.cajaAlCobrarId)
    try {
      const { postCashSaleToDrawer } = await import('@/services/shared/cashDrawerPosting')
      await postCashSaleToDrawer({
        venueId,
        paymentId: payment.id,
        targetSessionId: paymentResult.cajaAlCobrarId,
        exigirAbierta: true,
        // El método REAL: un cobro declarado a mano (terminal ajena, transferencia)
        // o con un tender del catálogo viaja por este mismo servicio y NUNCA entró al
        // cajón — salvo que el tender diga explícitamente que sí (vale de despensa).
        method: tenderState.resolved?.method ?? paymentMethod,
        tenderCountsAsCash: tenderState.resolved?.tenderCountsAsCash ?? null,
        fundsFlow: tenderState.resolved?.fundsFlow ?? null,
        tenderTypeId: tenderState.resolved?.tenderTypeId ?? null,
        status: 'COMPLETED',
        type: 'REGULAR',
        amount: amountDecimal,
        tipAmount: tipDecimal,
        staffId: effectiveStaffId || input.staffId || null,
        orderId,
      })
    } catch (err) {
      logger.error('[ORDER.MOBILE] Cash drawer posting failed (payment unaffected)', {
        paymentId: payment.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }

  // Inventory deduction on full payment (platform rule: stock deducts ONLY when
  // fully paid). This path historically skipped deduction entirely — cash sales
  // from desktop/tablets never lowered stock. Reuses the never-throws helper
  // from the TPV free-cart path: payment success is NEVER at risk (errors are
  // logged, not thrown), and it only fires on the PENDING/PARTIAL → PAID
  // transition (re-calls are blocked above by the "already paid" guard).
  // Weighted lines (weightQuantity) deduct kilos; see spec venta-por-peso.
  // La deducción se ESPERA (antes era fire-and-forget) para que la respuesta
  // pueda traer `inventoryWarning` y el POS pinte el toast ámbar post-cobro
  // (Square-parity, mismo contrato que el TPV). El cobro ya quedó commiteado
  // arriba: un fallo aquí se loguea y la respuesta sale igual, sin aviso.
  let inventoryWarning: OrderInventoryWarning | undefined
  if (orderFullyPaid && postingId) {
    try {
      // Fase 2 (posting durable): la deducción corre APLICANDO el posting que
      // nació en la transacción del cobro. Un posting SKIPPED (área-tickets:
      // ya dedujeron en su finalización transaccional) no pasa el claim y no
      // deduce. Reintentable por línea; el job de respaldo recoge lo que un
      // crash deje a medias.
      const { applySalePosting } = await import('@/services/inventory/inventoryPosting.service')
      const applied = await applySalePosting(postingId, effectiveStaffId || input.staffId || null)
      if (applied && applied.issues.length > 0) {
        const { buildInventoryWarning } = await import('@/services/tpv/payment.tpv.service')
        inventoryWarning = buildInventoryWarning(applied.issues, applied.applied)
      }
    } catch (err) {
      logger.error('[ORDER.MOBILE] Post-payment inventory posting failed (payment unaffected)', {
        orderId,
        postingId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (orderFullyPaid) {
    // Real-time auto-reorder, mirroring recordOrderPayment: if this sale
    // left an ingredient at/below its reorder point, create the PO now.
    // Self-gated (feature + PREMIUM tier + config.enabled) and non-blocking.
    // Corre con la venta pagada aunque el posting sea SKIPPED (área-tickets).
    void (async () => {
      try {
        const { runAutoReorderForVenue } = await import('@/services/dashboard/autoReorder.service')
        await runAutoReorderForVenue(venueId)
      } catch (err) {
        logger.error('[ORDER.MOBILE] Post-payment auto-reorder failed (payment unaffected)', {
          orderId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })()
  }

  // Auto-generate the digital receipt so the dashboard drawer, "Enviar recibo",
  // AND the mobile client's receipt QR (customer display + printed receipt) all
  // have an accessKey. AWAITED (was fire-and-forget) so the accessKey rides back
  // in THIS response — the mobile cash path had no other way to learn it, so
  // efectivo showed no QR while tarjeta (terminal) did. Mirrors the TPV order/
  // fast endpoints, which return `digitalReceipt` synchronously. Wrapped so a
  // receipt failure NEVER breaks the payment (degrades to digitalReceipt: null).
  let digitalReceipt: { accessKey: string; receiptUrl: string; autofacturaAvailable: boolean } | null = null
  try {
    const receipt = await generateAndStoreReceipt(venueId, payment.id)
    const autofacturaAvailable = await resolveAutofacturaAvailable(orderId)
    digitalReceipt = mapDigitalReceiptResponse(receipt, autofacturaAvailable)
  } catch (err) {
    logger.error('[ORDER.MOBILE] Failed to auto-generate digital receipt', {
      paymentId: payment.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // REFERRAL HOOK: trigger referral qualification if this order has a pending referral
  // (idempotent: no-ops if no PENDING Referral matches this orderId)
  //
  // 🔴 SÓLO cuando la orden quedó realmente PAGADA. Antes corría tras CUALQUIER
  // abono en efectivo, y `onOrderPaid` reclama el referido (PENDING → QUALIFIED)
  // mirando sólo `qualifyingOrderId`, sin revalidar el estado de la orden: un
  // abono de $1 sobre una cuenta de $500 calificaba el referido y emitía sus
  // recompensas. El nombre del hook lo dice — "onOrderPaid", no "onPayment".
  // El try/catch se conserva: un fallo del hook jamás puede tumbar un cobro.
  if (orderFullyPaid) {
    try {
      const { onOrderPaid } = await import('@/services/referrals/referralQualification.service')
      await onOrderPaid({ orderId, venueId })
    } catch (err) {
      console.error('[referral hook] onOrderPaid failed for order', orderId, err)
    }
  }

  // 🎁 LEALTAD (puntos y SELLOS): la misma regla que la PAX, por el mismo helper.
  //
  // 🔴 Este camino NUNCA la llamó. El café pagado en efectivo desde el Sunmi no
  // daba sello ni puntos, y el MISMO café cobrado con tarjeta en la PAX sí
  // (Testarudo, 2026-09-01). Al cliente que pagó su séptimo café en efectivo se le
  // quedaba a deber su café gratis — y nada fallaba, así que nadie se enteraba.
  //
  // Base: venta/cargos menos propinas, igual en todos los canales. La propina
  // pertenece al personal y nunca compra puntos. SÓLO con la
  // cuenta SALDADA: un abono de $1 no puede acercar a nadie al café gratis.
  // `awardLoyaltyForPaidOrder` no lanza, pero el try/catch se queda: el cobro ya
  // está commiteado y nada de aquí abajo puede desmentirlo.
  if (orderFullyPaid) {
    try {
      const { awardLoyaltyForPaidOrder } = await import('@/services/shared/loyaltyOnPaidOrder')
      await awardLoyaltyForPaidOrder({
        venueId,
        orderId,
        orderTotal: loyaltyBase,
        staffId: effectiveStaffId,
        legacyCustomer: order.customer
          ? { id: order.customer.id, firstName: order.customer.firstName, lastName: order.customer.lastName }
          : null,
      })
    } catch (err) {
      logger.error('[ORDER.MOBILE] Post-payment loyalty failed (payment unaffected)', {
        orderId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // 🍳 Etapa 3 del KDS: la comanda de pantalla nace al quedar la venta PAGADA. Después del commit; si falla, la marca
  // `kitchenPendingAt` queda y el barrido la arma. `armarComandasTrasCommit` nunca lanza.
  if (orderFullyPaid && marcarCocina) {
    await armarComandasTrasCommit(venueId, orderId, 'PAID')
  }

  // Emit Socket.IO events for real-time updates
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastToVenue(venueId, SocketEventType.PAYMENT_COMPLETED, {
      paymentId: payment.id,
      orderId,
      orderNumber: order.orderNumber,
      amount: amountDecimal,
      tipAmount: tipDecimal,
      method: tenderState.resolved?.method ?? paymentMethod,
      status: 'completed',
    })

    // 🔴 El estado REAL, no un literal. Emitir 'PAID' fijo hacía que el
    // dashboard —y cualquier otro cliente escuchando— pintara como pagada una
    // cuenta que apenas recibió un abono.
    broadcastingService.broadcastToVenue(venueId, SocketEventType.ORDER_UPDATED, {
      orderId,
      orderNumber: order.orderNumber,
      paymentStatus: balance.orderPaymentStatus,
    })
  }

  return {
    paymentId: payment.id,
    orderId,
    orderNumber: order.orderNumber,
    amount: aplicadoCents,
    tipAmount: tip,
    changeCents: cambioCents,
    method: tenderState.resolved?.method ?? paymentMethod,
    status: 'COMPLETED',
    digitalReceipt,
    ...(inventoryWarning ? { inventoryWarning } : {}),
    // Saldo autoritativo, en centavos enteros como el resto de esta respuesta.
    // El POS ya no tiene que deducirlo del carrito.
    ...balance,
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TARJETAS DE REGALO — cobrar con saldo (spec 2026-10-14 § 5.4, R5)
// ══════════════════════════════════════════════════════════════════════════════

const LLAVE_DE_COBRO_CON_SALDO = /^[A-Za-z0-9_-]{8,64}$/
const LLAVE_DE_OPERACION_DE_SALDO = /^[A-Za-z0-9_:-]{8,128}$/
/**
 * A8, ruling 3: el cobro con saldo comparte el núcleo con `payCashOrder`, pero la auditoría del turno
 * (`PAYMENT_WITHOUT_SHIFT`) y la de una reapertura lo nombran a él, nunca al efectivo.
 */
const CANAL_DEL_COBRO_CON_SALDO = { turno: 'payGiftCardBalanceOnOrder', reapertura: 'payGiftCardBalanceOnOrder' } as const

/** Formas del índice («Adiciones al contrato» § 2, enmienda E7). C3 convierte los montos a Decimal desde su texto. */
export interface PayGiftCardBalanceInput {
  /** 8–64 [A-Za-z0-9_-]; la MISMA en cada reintento (Payment [venueId, idempotencyKey], R12). */
  idempotencyKey: string
  /** Prueba de posesión: el código tecleado o escaneado. La 1c agrega `{ kind: 'WALLET_PASS'; qrToken }`. */
  proof: { kind: 'CODE'; code: string }
  /** Pesos, venta SIN propina, > 0, centavos exactos. Nunca más de lo que debe la cuenta (R5). */
  amount: Prisma.Decimal
  /** Pesos, ≥ 0 (el tender de regalo captura propina, D8). */
  tip: Prisma.Decimal
  /** `Staff.id`. */
  staffId: string
  /** `X-Device-Id`. */
  deviceId: string | null
}

export interface PayGiftCardBalanceResult {
  paymentId: string
  orderId: string
  orderNumber: string
  /** Pesos. */
  amount: number
  tipAmount: number
  /** Un renglón por sobre descontado (venta + propina), con el saldo que le quedó. */
  redeemed: Array<{ giftCardId: string; last4: string; amount: number; balanceAfter: number }>
  /** Pesos que todavía debe la cuenta. */
  orderRemaining: number
  orderPaymentStatus: 'PARTIAL' | 'PAID'
  /**
   * Decisión del coordinador (conciliación 14-oct): el recibo digital con la MISMA forma y el MISMO armado que la respuesta
   * de `payCashOrder` (`generateAndStoreReceipt` + `mapDigitalReceiptResponse`, después del commit). Un recibo que falla
   * nunca tumba el cobro: llega `null`. En un reintento por llave, el recibo que ya se guardó.
   */
  digitalReceipt?: { accessKey: string; receiptUrl: string; autofacturaAvailable: boolean } | null
  /**
   * r1 (F9): `true` = la llave ya tenía su cobro —reintento o carrera perdida—; es la respuesta del primer cobro y no se
   * movió saldo. `payGiftCardBalanceOnOrder` siempre lo manda (`false` sólo si ESTA llamada creó el Payment); C3 escribe
   * `GIFT_CARD_REDEEMED` sólo con `false`. `getGiftCardPaymentByKey` no lo pone (es una consulta).
   */
  replay?: boolean
}

function pesosExactos(valor: unknown, campo: string): Prisma.Decimal {
  if (!Prisma.Decimal.isDecimal(valor) || !valor.isFinite() || valor.isNegative()) {
    throw new BadRequestError(`${campo} debe ser un monto en pesos (no negativo).`)
  }
  if (valor.decimalPlaces() > 2) throw new BadRequestError(`${campo} debe llevar centavos exactos.`)
  return valor
}

/** Centavos enteros → pesos, exacto (no hay `centsToPesos` en el repo). */
function centavosAPesos(centavos: number | undefined): number {
  return new Prisma.Decimal(centavos ?? 0).dividedBy(100).toNumber()
}

function tarjetaNoEncontrada(): GiftCardError {
  return new GiftCardError('GIFT_CARD_NOT_FOUND', 'No encontramos esa tarjeta de regalo en este negocio. Revisa el código.', 404)
}

/** El cobro con saldo de una llave, tal como lo devolvería el primer intento. `null` si no existe o no es de saldo. */
export async function getGiftCardPaymentByKey(venueId: string, idempotencyKey: string): Promise<PayGiftCardBalanceResult | null> {
  const payment = await prisma.payment.findUnique({
    where: { venueId_idempotencyKey: { venueId, idempotencyKey } },
    select: {
      id: true,
      orderId: true,
      amount: true,
      tipAmount: true,
      tenderType: { select: { systemKind: true } },
      order: { select: { orderNumber: true } },
      receipts: RECIBO_CANONICO,
    },
  })
  if (!payment?.orderId || !isGiftCardTenderKind(payment.tenderType?.systemKind)) return null
  // Un cobro con saldo descuenta UN sobre en la 1a (una prueba de posesión), y nunca más de MAX_SOBRES_POR_CUENTA: este
  // `take` lee todos (ruling 6).
  const canjes = await prisma.giftCardActivity.findMany({
    where: { venueId, paymentId: payment.id, type: 'REDEEM' },
    select: { giftCardId: true, amount: true, balanceAfter: true, giftCard: { select: { codeLast4: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: MAX_SOBRES_POR_CUENTA,
  })
  const saldo = await readOrderBalanceSnapshot(venueId, payment.orderId)
  return {
    paymentId: payment.id,
    orderId: payment.orderId,
    orderNumber: payment.order?.orderNumber ?? '',
    amount: Number(payment.amount),
    tipAmount: Number(payment.tipAmount),
    redeemed: canjes.map(c => ({
      giftCardId: c.giftCardId,
      last4: c.giftCard.codeLast4,
      amount: Number(c.amount),
      balanceAfter: Number(c.balanceAfter),
    })),
    orderRemaining: centavosAPesos(saldo.remainingBalanceCents),
    orderPaymentStatus: saldo.orderPaymentStatus ?? 'PARTIAL',
    // Como el reintento de `payCashOrder`: el recibo que ya se guardó para este cobro.
    digitalReceipt: payment.receipts?.[0]
      ? mapDigitalReceiptResponse(payment.receipts[0], await resolveAutofacturaAvailable(payment.orderId))
      : null,
  }
}

/**
 * Cobrar con saldo de tarjeta de regalo en UNA transacción (R5): Order → sobre → turno; descuento condicionado; un REDEEM
 * por sobre y UN Payment del tender de sistema. Online-only. Nunca efectivo ni cambio: el monto no pasa de lo que debe la
 * cuenta y nunca hay vuelto. Cobrar no se gatea por plan (§ 6): una tarjeta vendida se honra aunque la función se apague.
 */
export async function payGiftCardBalanceOnOrder(
  venueId: string,
  orderId: string,
  input: PayGiftCardBalanceInput,
): Promise<PayGiftCardBalanceResult> {
  if (!LLAVE_DE_COBRO_CON_SALDO.test(input?.idempotencyKey ?? '')) {
    throw new BadRequestError('idempotencyKey debe tener de 8 a 64 caracteres (letras, números, guion o guion bajo).')
  }
  if (input?.proof?.kind !== 'CODE' || typeof input.proof.code !== 'string') {
    throw new BadRequestError('Por ahora el saldo se cobra con el código de la tarjeta (proof.kind = CODE).')
  }
  const monto = pesosExactos(input.amount, 'amount')
  const propina = pesosExactos(input.tip ?? new Prisma.Decimal(0), 'tip')
  if (!monto.greaterThan(0))
    throw new GiftCardError('GIFT_CARD_AMOUNT_OUT_OF_RANGE', 'El monto a pagar con saldo debe ser mayor a cero.', 422)

  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
    select: {
      id: true,
      orderNumber: true,
      // Ronda 1 (fix 2): las salidas de repetición completan la liberación de la mesa, como `payCashOrder`.
      tableId: true,
      areaTicketCheckoutSession: { select: { id: true } },
      customer: { select: { id: true, firstName: true, lastName: true } },
    },
  })
  if (!order) throw new NotFoundError('Order not found')
  if (order.areaTicketCheckoutSession) {
    throw new GiftCardError(
      'GIFT_CARD_TENDER_NOT_ALLOWED',
      'Las ventas con vales por área no se pagan con saldo de tarjeta de regalo.',
      409,
    )
  }

  const normalizado = normalizeGiftCardCode(input.proof.code)
  // La huella de la prueba presentada: resuelve el sobre aquí y se vuelve a comparar BAJO el candado (r1, A-1).
  const huellaPresentada = normalizado ? hashGiftCardCode(normalizado) : null
  const sobre = huellaPresentada
    ? await prisma.giftCard.findFirst({ where: { venueId, codeHash: huellaPresentada }, select: { id: true, codeLast4: true } })
    : null
  if (!sobre) throw tarjetaNoEncontrada()

  const conflicto = () =>
    new GiftCardError('IDEMPOTENCY_KEY_REUSED', 'Esta llave ya registró otro cobro. Genera una llave nueva para este cobro.', 409)
  const mismoCobro = (previo: PayGiftCardBalanceResult) =>
    previo.orderId === orderId &&
    new Prisma.Decimal(previo.amount).equals(monto) &&
    new Prisma.Decimal(previo.tipAmount).equals(propina) &&
    previo.redeemed.every(s => s.giftCardId === sobre.id)

  const yaExiste = await prisma.payment.findUnique({
    where: { venueId_idempotencyKey: { venueId, idempotencyKey: input.idempotencyKey } },
    select: { id: true },
  })
  if (yaExiste) {
    const previo = await getGiftCardPaymentByKey(venueId, input.idempotencyKey)
    if (!previo || !mismoCobro(previo)) throw conflicto()
    // Si una caída se llevó la liberación de la mesa del primer cobro (que saldó la cuenta), el reintento la completa.
    await liberarMesaSiQuedoSaldada(venueId, order.tableId, orderId)
    return { ...previo, replay: true }
  }

  await ensureGiftCardTender(prisma, venueId)
  const effectiveStaffId = await validateStaffVenue(input.staffId, venueId)
  // El gate se resuelve FUERA de la transacción, como en `payCashOrder`, y viaja como 4º argumento del núcleo: la
  // guardia AST de turnos lo sigue de llamada en llamada hasta esta lectura canónica (ruling 1 de A8).
  const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venueId)
  const marcarCocina = await debeMarcarCocina(venueId, { orderId })

  let bloqueados: LockedGiftCard[] = []
  let canje: Array<{ giftCardId: string; amount: Prisma.Decimal; balanceAfter: Prisma.Decimal }> = []
  let abono: AbonoEnTx
  try {
    abono = await prisma.$transaction(async tx => {
      const tenderResuelto = await resolveGiftCardTenderForChargeInTx(tx, venueId)
      return await registrarAbonoEnTx(
        tx,
        { venueId, orderId, effectiveStaffId, marcarCocina },
        {
          amountCents: pesosToCents(monto.toNumber()),
          tipCents: pesosToCents(propina.toNumber()),
          method: 'OTHER',
          idempotencyKey: input.idempotencyKey,
          isOfflineReplay: false,
          tender: { resuelto: tenderResuelto },
          canal: CANAL_DEL_COBRO_CON_SALDO,
          // Bajo el candado de la Order y ANTES de que el núcleo reclame el turno: aquí se rechaza todo lo que no puede
          // pagar y se bloquea el sobre (E4: Order → sobre → turno; ruling 5). Después del turno no se toma ningún sobre.
          trasCandadoDeOrden: async (txCandado, cuenta) => {
            // Un cobro con saldo es un cobro NUEVO: sobre una cancelada no se registra (el núcleo la reabriría).
            rechazarCobroNuevoSobreCancelada(cuenta.fresh.status)
            // D8 / ruling 8: una tarjeta no se paga con saldo de otra (spec: no se compran tarjetas con saldo).
            if (await esCuentaDeTarjetasEnTx(txCandado, orderId)) {
              throw new GiftCardError(
                'GIFT_CARD_TENDER_NOT_ALLOWED',
                'Una tarjeta de regalo no se paga con saldo de otra tarjeta de regalo.',
                409,
              )
            }
            const pendiente = computeOrderBalance(cuenta.fresh, cuenta.previousPayments).remainingBalance
            if (monto.greaterThan(pendiente)) {
              throw new GiftCardError(
                'GIFT_CARD_AMOUNT_OUT_OF_RANGE',
                `Esta cuenta debe ${formatoPesos(pendiente)}: el saldo de la tarjeta no paga de más.`,
                422,
                { pendiente: pendiente.toNumber() },
              )
            }
            // Una prueba de posesión = un sobre (ruling 6: un cobro nunca descuenta más de MAX_SOBRES_POR_CUENTA, así
            // que las lecturas acotadas de la libreta —`sobresDelCanje`, `revertirCanjeEnTx`— lo ven completo).
            bloqueados = await lockGiftCardsForUpdate(txCandado, [sobre.id])
            const [card] = bloqueados
            if (!card || card.venueId !== venueId || card.status === 'PENDING' || card.status === 'DEACTIVATED') throw tarjetaNoEncontrada()
            // r1 (A-1): el código se resolvió a un sobre ANTES de la transacción; si el gerente lo reemplazó mientras
            // esperábamos el candado, la huella vigente ya no es la de la prueba presentada: el código anterior no sirve.
            if (card.codeHash !== huellaPresentada) throw tarjetaNoEncontrada()
            if (card.status === 'BLOCKED') {
              throw new GiftCardError('GIFT_CARD_BLOCKED', 'Esta tarjeta de regalo está bloqueada. Pide al gerente que la revise.', 409)
            }
            if (card.status !== 'ACTIVE') throw tarjetaNoEncontrada()
            if (card.expiresAt && card.expiresAt.getTime() <= Date.now()) {
              throw new GiftCardError('GIFT_CARD_EXPIRED', 'Esta tarjeta de regalo ya venció.', 409)
            }
            const disponible = saldoUsable(bloqueados, new Date())
            if (disponible.lessThan(monto.plus(propina))) {
              throw new GiftCardError(
                'GIFT_CARD_INSUFFICIENT_BALANCE',
                `Quedan ${formatoPesos(disponible)} en la tarjeta de regalo.`,
                409,
                {
                  saldoDisponible: disponible.toNumber(),
                },
              )
            }
          },
          // El descuento escribe en el sobre que el gancho YA bloqueó: no toma candado nuevo después del turno.
          dentroDeLaTx: async (txCobro, cobro) => {
            canje = await canjearSobresEnTx(txCobro, {
              venueId,
              orderId,
              paymentId: cobro.paymentId,
              amount: monto.plus(propina),
              cards: bloqueados,
              staffId: effectiveStaffId ?? null,
              deviceId: input.deviceId ?? null,
            })
          },
        },
        reconciliationEnabled,
      )
    }, ORDER_LOCK_WAIT_BUDGET)
  } catch (err: any) {
    // r1 (A-2): carrera idempotente. Dos peticiones con la MISMA llave pasan la consulta de arriba; la segunda espera la
    // Order y, cuando entra, la cuenta ya está pagada o el saldo ya se consumió: falla ANTES del índice único de Payment
    // (cuenta PAGADA, GIFT_CARD_INSUFFICIENT_BALANCE, GIFT_CARD_AMOUNT_OUT_OF_RANGE por pendiente, CAS perdido). Antes
    // de mostrar CUALQUIER error se busca el cobro de la ganadora por la llave: mismo contenido ⇒ su respuesta, como
    // repetición; otro contenido ⇒ IDEMPOTENCY_KEY_REUSED. Sin ganadora, el error es real y sigue su camino.
    // Ronda 1 (fix 3): si la búsqueda de la ganadora falla (la base no contesta), sale el error ORIGINAL del cobro.
    let ganador: PayGiftCardBalanceResult | null
    try {
      ganador = await getGiftCardPaymentByKey(venueId, input.idempotencyKey)
    } catch (busqueda) {
      logger.warn('[ORDER.MOBILE] No se pudo buscar el cobro con saldo de esta llave tras un error; sale el error original', {
        venueId,
        orderId,
        error: busqueda instanceof Error ? busqueda.message : String(busqueda),
      })
      throw err
    }
    if (ganador) {
      if (mismoCobro(ganador)) {
        await liberarMesaSiQuedoSaldada(venueId, order.tableId, orderId)
        return { ...ganador, replay: true }
      }
      throw conflicto()
    }
    if (err?.code === 'P2002' || err instanceof CobroYaRegistrado) throw conflicto()
    if (err?.code === 'PAY_CASH_CAS_LOST') {
      throw new ConflictError(
        'La cuenta cambió mientras se cobraba con saldo. Vuelve a intentar con la MISMA llave.',
        'ORDER_PAYMENT_CONFLICT',
      )
    }
    throw err
  }

  const { newPayment: payment, isFullyPaid, postingId, balance, loyaltyBase } = abono
  logger.info(`🎁 [ORDER.MOBILE] Cobro con saldo de tarjeta de regalo | paymentId=${payment.id} | order=${order.orderNumber}`)

  if (isFullyPaid && !abono.areaTicketOrder && abono.tableId) {
    try {
      const { releaseTableIfSettled } = await import('../tpv/table.tpv.service')
      await releaseTableIfSettled(venueId, abono.tableId)
    } catch (error) {
      logger.error('[ORDER.MOBILE] Liberar la mesa tras el cobro con saldo falló (el cobro quedó)', {
        orderId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (isFullyPaid && postingId) {
    try {
      const { applySalePosting } = await import('@/services/inventory/inventoryPosting.service')
      await applySalePosting(postingId, effectiveStaffId || input.staffId || null)
    } catch (error) {
      logger.error('[ORDER.MOBILE] El inventario tras el cobro con saldo falló (el cobro quedó)', {
        orderId,
        postingId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (isFullyPaid) {
    void (async () => {
      try {
        const { runAutoReorderForVenue } = await import('@/services/dashboard/autoReorder.service')
        await runAutoReorderForVenue(venueId)
      } catch (error) {
        logger.error('[ORDER.MOBILE] Auto-reorden tras el cobro con saldo falló', {
          orderId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })()
  }
  // El recibo digital, armado IGUAL que en `payCashOrder` (después del commit, esperado para que el accessKey viaje en ESTA
  // respuesta); si falla, el cobro no se cae y llega `null` (decisión del coordinador, conciliación 14-oct).
  let digitalReceipt: PayGiftCardBalanceResult['digitalReceipt'] = null
  try {
    const receipt = await generateAndStoreReceipt(venueId, payment.id)
    digitalReceipt = mapDigitalReceiptResponse(receipt, await resolveAutofacturaAvailable(orderId))
  } catch (error) {
    logger.error('[ORDER.MOBILE] Recibo del cobro con saldo falló', {
      paymentId: payment.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  if (isFullyPaid) {
    try {
      const { onOrderPaid } = await import('@/services/referrals/referralQualification.service')
      await onOrderPaid({ orderId, venueId })
    } catch (error) {
      logger.error('[ORDER.MOBILE] Referidos tras el cobro con saldo fallaron', {
        orderId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    // R1: USAR la tarjeta sí da sellos y puntos, como cualquier compra (spec § 5.4.5).
    try {
      const { awardLoyaltyForPaidOrder } = await import('@/services/shared/loyaltyOnPaidOrder')
      await awardLoyaltyForPaidOrder({
        venueId,
        orderId,
        orderTotal: loyaltyBase,
        staffId: effectiveStaffId,
        legacyCustomer: order.customer
          ? { id: order.customer.id, firstName: order.customer.firstName, lastName: order.customer.lastName }
          : null,
      })
    } catch (error) {
      logger.error('[ORDER.MOBILE] Lealtad tras el cobro con saldo falló', {
        orderId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (isFullyPaid && marcarCocina) await armarComandasTrasCommit(venueId, orderId, 'PAID')

  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastToVenue(venueId, SocketEventType.PAYMENT_COMPLETED, {
      paymentId: payment.id,
      orderId,
      orderNumber: order.orderNumber,
      amount: monto.toNumber(),
      tipAmount: propina.toNumber(),
      method: 'OTHER',
      status: 'completed',
    })
    broadcastingService.broadcastToVenue(venueId, SocketEventType.ORDER_UPDATED, {
      orderId,
      orderNumber: order.orderNumber,
      paymentStatus: balance.orderPaymentStatus,
    })
  }

  return {
    paymentId: payment.id,
    orderId,
    orderNumber: order.orderNumber,
    amount: monto.toNumber(),
    tipAmount: propina.toNumber(),
    redeemed: canje.map(c => ({
      giftCardId: c.giftCardId,
      last4: sobre.codeLast4,
      amount: c.amount.toNumber(),
      balanceAfter: c.balanceAfter.toNumber(),
    })),
    orderRemaining: centavosAPesos(balance.remainingBalanceCents),
    orderPaymentStatus: balance.orderPaymentStatus,
    digitalReceipt,
    replay: false,
  }
}

/**
 * «Regresar el saldo y cancelar la cuenta» (spec § 5.4.4): el cliente se fue después de pagar una parte con saldo. Sólo
 * para cuentas NO pagadas cuyos únicos pagos vivos son del tender de regalo. Un camino propio bajo el mismo candado que
 * `cancelOrderInTransaction`; el guardia general de cancelación no se relaja. Devuelve `replay: true` si la cuenta ya la
 * había cancelado esta misma `operationKey` (r1, F9: la bitácora la escribe C3 sólo con `replay: false`; aquí no).
 *
 * Ruling 7 (A8): un sobre DEACTIVATED (la terminal ya devolvió el dinero de su compra, E1) nunca recibe saldo de vuelta en
 * silencio: la operación se rechaza entera ANTES de escribir nada. El cobro con saldo sigue vivo y a la vista en la cuenta
 * abierta, y ese sobre lleva su anomalía `REFUND_WITHOUT_CANCEL` (E1: la escribe el gancho de reembolsos de B1); el
 * gerente decide.
 */
export async function returnGiftBalanceAndCancelOrder(
  venueId: string,
  orderId: string,
  input: { staffId: string; operationKey: string },
): Promise<{ replay: boolean }> {
  if (!LLAVE_DE_OPERACION_DE_SALDO.test(input?.operationKey ?? '')) {
    throw new BadRequestError(
      'La llave de la operación debe tener de 8 a 128 caracteres (letras, números, guion, guion bajo o dos puntos).',
    )
  }
  const staffId = await validateStaffVenue(input.staffId, venueId)
  const raiz = 'gr' + createHash('sha256').update(input.operationKey).digest('hex').slice(0, 48)
  const llaveDeReverso = (i: number) => `${raiz}:${i}`
  const { bloquearCobroParaReembolso, writeRefundInTx } = await import('../shared/writeRefundInTx')
  /** Lo que falta devolver de un cobro ya bloqueado (venta y propina por separado), en centavos. */
  const pendienteDeDevolver = (b: Awaited<ReturnType<typeof bloquearCobroParaReembolso>>) => ({
    ventaCents: Math.max(0, pesosToCents(Number(b.original.amount)) - b.refundedSalesCents),
    propinaCents: Math.max(0, pesosToCents(Number(b.original.tipAmount)) - b.refundedTipsCents),
  })

  const resultado = await prisma.$transaction(async tx => {
    let scope: Awaited<ReturnType<typeof lockTableOrderScope>>
    try {
      scope = await lockTableOrderScope(tx, { venueId, orderIds: [orderId], kdsOrderIds: [orderId] })
    } catch (error) {
      if (error instanceof NotFoundError && error.message === 'Venue not found') throw new NotFoundError('Order not found')
      throw error
    }
    const cuenta = await tx.order.findUnique({ where: { id: orderId, venueId }, select: { id: true, status: true, paymentStatus: true } })
    if (!cuenta) throw new NotFoundError('Order not found')
    /** El tender de regalo y los pagos vivos de la cuenta (uno de más para saber si pasan del tope). */
    const leerCobros = async () => ({
      tender: await tx.venueTenderType.findFirst({ where: { venueId, systemKind: 'GIFT_CARD' }, select: { id: true } }),
      cobros: await tx.payment.findMany({
        where: { venueId, orderId, status: 'COMPLETED', OR: [{ type: null }, { type: { not: 'REFUND' } }] },
        select: { id: true, tenderTypeId: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: MAX_SOBRES_POR_CUENTA + 1,
      }),
    })

    // La primera devolución ESCRITA lleva siempre la llave `:0` (abajo): si existe, esta operación ya corrió.
    const previo = await tx.payment.findUnique({
      where: { venueId_idempotencyKey: { venueId, idempotencyKey: llaveDeReverso(0) } },
      select: { orderId: true },
    })
    if (previo && previo.orderId !== orderId) {
      throw new GiftCardError(
        'IDEMPOTENCY_KEY_REUSED',
        'Esta llave ya se usó para regresar el saldo de otra cuenta. Vuelve a intentarlo desde la cuenta.',
        409,
      )
    }
    if (claseDeEstado(cuenta.status) === 'CANCELADA') {
      if (previo) return null // reintento de una operación que ya terminó
      // Ronda 1 (fix 1): si ya no quedaba nada que regresar, la primera llamada canceló SIN escribir ninguna devolución y
      // no existe `:0`. Su reintento (la respuesta se perdió y la cola lo reenvía) se reconoce porque TODOS los pagos vivos
      // de la cuenta son del tender de regalo y ya están devueltos completos: es una repetición y nada se escribe. Este
      // camino es el único que cancela esa cuenta (el guardia general rechaza una PARTIAL), así que no se rechaza antes.
      const { tender, cobros } = await leerCobros()
      const soloSaldo = Boolean(tender) && cobros.length > 0 && cobros.length <= MAX_SOBRES_POR_CUENTA
      if (soloSaldo && cobros.every(c => c.tenderTypeId === tender?.id)) {
        let todoDevuelto = true
        for (const cobro of cobros) {
          const pendiente = pendienteDeDevolver(
            await bloquearCobroParaReembolso(tx, { venueId, paymentId: cobro.id, expectedOrderId: orderId }),
          )
          if (pendiente.ventaCents + pendiente.propinaCents > 0) {
            todoDevuelto = false
            break
          }
        }
        if (todoDevuelto) return null
      }
      throw new BadRequestError('Esta cuenta ya está cancelada.', 'ORDER_ALREADY_CANCELLED')
    }
    if (cuenta.paymentStatus === 'PAID') {
      throw new GiftCardError('GIFT_CARD_TENDER_NOT_ALLOWED', 'Esta cuenta ya está pagada: para devolver dinero usa un reembolso.', 409)
    }

    const kds = await retirarComandasDeVentaAnulada(tx, venueId, orderId, { staffId, reason: 'Saldo de tarjeta de regalo regresado' })
    await assertNoLiveTerminalCharge(tx, { venueId, orderId })
    const { tender, cobros } = await leerCobros()
    if (!tender || cobros.length === 0 || cobros.some(c => c.tenderTypeId !== tender.id)) {
      throw new GiftCardError(
        'GIFT_CARD_TENDER_NOT_ALLOWED',
        'Sólo se regresa el saldo y se cancela una cuenta cuyos únicos pagos son con tarjeta de regalo.',
        409,
      )
    }
    // Ronda 1 (fix 5): pasar del tope tiene su propio mensaje (antes decía que había pagos que no eran de saldo).
    if (cobros.length > MAX_SOBRES_POR_CUENTA) {
      throw new GiftCardError(
        'GIFT_CARD_TENDER_NOT_ALLOWED',
        `Esta cuenta tiene más de ${MAX_SOBRES_POR_CUENTA} cobros con saldo de tarjeta de regalo: no se pueden regresar todos de una vez. Pide al gerente que la revise.`,
        409,
        { motivo: 'DEMASIADOS_COBROS', maximo: MAX_SOBRES_POR_CUENTA },
      )
    }

    // r1 (A-3) y ruling 5: Order → cobros originales → sobres → turno, TODO antes del primer `writeRefundInTx` (que reclama
    // el turno, `claimShiftForRefund`). Con dos o más cobros, bloquear los sobres del segundo teniendo ya el turno abriría
    // un ciclo de espera con otra caja que tenga ese sobre y espere el mismo turno (E4). Se bloquean los cobros en el orden
    // de `cobros` y la UNIÓN de sus sobres en UNA llamada (el ORDER BY de `lockGiftCardsForUpdate` es el orden canónico).
    // El bucle de abajo reusa esos candados: el que vuelve a pedir `revertirCanjeEnTx` es sobre filas ya tomadas (cada
    // cobro descuenta un solo sobre, ruling 6, así que `sobresDelCanje` y la libreta leen el mismo conjunto).
    const bloqueos: Array<Awaited<ReturnType<typeof bloquearCobroParaReembolso>>> = []
    for (const cobro of cobros) {
      bloqueos.push(await bloquearCobroParaReembolso(tx, { venueId, paymentId: cobro.id, expectedOrderId: orderId }))
    }
    // Lo que falta devolver de cada cobro. Uno ya devuelto completo no se toca (ni su sobre se bloquea).
    const porDevolver = cobros
      .map((cobro, i) => ({ cobro, bloqueado: bloqueos[i], ...pendienteDeDevolver(bloqueos[i]) }))
      .filter(p => p.ventaCents + p.propinaCents > 0)
    const sobresDeLosCobros: string[] = []
    for (const p of porDevolver) sobresDeLosCobros.push(...(await sobresDelCanje(tx, { venueId, paymentId: p.cobro.id })))
    const sobres = await lockGiftCardsForUpdate(tx, sobresDeLosCobros)

    // Ruling 7: un sobre DEACTIVATED no recibe saldo de vuelta (`revertirCanjeEnTx` le sumaría saldo a una tarjeta muerta,
    // fuera de la vista de todos). Se rechaza todo antes de escribir: el cobro con saldo sigue en la cuenta abierta.
    const desactivados = sobres.filter(s => s.status === 'DEACTIVATED')
    if (desactivados.length > 0) {
      const terminaciones = await tx.giftCard.findMany({
        where: { venueId, id: { in: desactivados.map(s => s.id) } },
        select: { id: true, codeLast4: true },
        orderBy: { id: 'asc' },
        take: MAX_SOBRES_POR_CUENTA,
      })
      const cuales = terminaciones.map(t => t.codeLast4).join(', ')
      throw new GiftCardError(
        'GIFT_CARD_TENDER_NOT_ALLOWED',
        desactivados.length === 1
          ? `La tarjeta de regalo terminación ${cuales} ya fue cancelada: su saldo no se puede regresar. Cobra lo que falta con otro medio o pide al gerente que la revise.`
          : `Las tarjetas de regalo terminación ${cuales} ya fueron canceladas: su saldo no se puede regresar. Cobra lo que falta con otro medio o pide al gerente que las revise.`,
        409,
        { motivo: 'SOBRE_DESACTIVADO', giftCardIds: desactivados.map(s => s.id) },
      )
    }

    // Llaves `:0`, `:1`… en el orden en que se ESCRIBEN: la primera devolución siempre es `:0` (la que reconoce el reintento).
    let escritas = 0
    for (const p of porDevolver) {
      const { refundPaymentId } = await writeRefundInTx(tx, {
        originalPaymentId: p.cobro.id,
        venueId,
        salesRefundCents: p.ventaCents,
        tipRefundCents: p.propinaCents,
        refundedItems: [],
        reason: 'CANCELLED_ORDER',
        note: 'Saldo de tarjeta de regalo regresado al cancelar la cuenta',
        staffId: staffId ?? null,
        idempotencyKey: llaveDeReverso(escritas),
        tenderCommission: 'NONE',
        shift: 'CLAIM_LIVE',
        provenance: 'MANUAL',
        bloqueado: p.bloqueado,
      })
      escritas += 1
      await enqueueRefundPaymentEffectsInTx(tx, refundPaymentId, p.cobro.id)
      await revertirCanjeEnTx(tx, {
        venueId,
        originalPaymentId: p.cobro.id,
        refundPaymentId,
        amount: new Prisma.Decimal(p.ventaCents + p.propinaCents).dividedBy(100),
        staffId: staffId ?? null,
      })
    }

    const cancelada = await tx.order.update({
      where: { id: orderId, venueId },
      data: { status: 'CANCELLED', version: { increment: 1 } },
      select: { tableId: true },
    })
    const boundTable = scope.tables.find(table => table.currentOrderId === orderId)
    const { reconcileTableAfterOrderRemovedInTransaction } = await import('../tpv/table.tpv.service')
    const reconciled = await reconcileTableAfterOrderRemovedInTransaction(tx, scope, orderId)
    const ownTable = reconciled.tables.find(table => table.id === cancelada.tableId)
    const table = reconciled.tables.find(row => row.id === boundTable?.id) ?? ownTable ?? null
    const tpvTableFreed = Boolean(ownTable?.status === 'AVAILABLE' && ownTable.currentOrderId === null)
    const affectedRefs: HttpEnvelope['affectedRefs'] = [
      { kind: 'Order', id: orderId },
      ...reconciled.tables.map(row => ({ kind: 'Table' as const, id: row.id })),
      ...kds.kdsOrderIds.map(id => ({ kind: 'KdsOrder' as const, id })),
      ...kds.kdsOrderItemIds.map(id => ({ kind: 'KdsOrderItem' as const, id })),
    ]
    return { orderId, table, tables: reconciled.tables, hadBoundTable: Boolean(boundTable), tpvTableFreed, affectedRefs }
  }, ORDER_LOCK_WAIT_BUDGET)

  if (!resultado) return { replay: true }
  await publishCancelledOrder(venueId, resultado, staffId, 'Saldo de tarjeta de regalo regresado')
  // r1 (F9): sin `logAction` aquí. `GIFT_CARD_BALANCE_RETURNED_ORDER_CANCELLED` tiene un solo dueño: el controller de C3,
  // fuera de la transacción y sólo con `replay: false`.
  return { replay: false }
}

/**
 * «Agregar cliente» en «Cobro exitoso» (POST /mobile/venues/:venueId/payments/:paymentId/customer).
 * `staffId` = quien LIGA (authContext.userId del controller): es el actor del sello tardío y de la bitácora.
 */
export async function attachCustomerToPayment(venueId: string, paymentId: string, customerId: string, staffId?: string | null) {
  const normalizedPaymentId = paymentId?.trim()
  const normalizedCustomerId = customerId?.trim()

  if (!normalizedPaymentId) {
    throw new BadRequestError('paymentId es requerido')
  }
  if (!normalizedCustomerId) {
    throw new BadRequestError('customerId es requerido')
  }

  const payment = await prisma.payment.findFirst({
    where: {
      id: normalizedPaymentId,
      venueId,
    },
    select: {
      id: true,
      orderId: true,
    },
  })

  if (!payment) {
    throw new NotFoundError('Payment not found')
  }

  return attachCustomerToOrder(venueId, payment.orderId, normalizedCustomerId, staffId)
}

export async function attachCustomerToLatestPayment(
  venueId: string,
  input: {
    customerId: string
    amountCents: number
    tipCents?: number
    staffId?: string | null
    /** Quien LIGA (authContext.userId). `staffId` sigue siendo quien COBRÓ: filtra processedById. */
    actorStaffId?: string | null
  },
) {
  const normalizedCustomerId = input.customerId?.trim()
  if (!normalizedCustomerId) {
    throw new BadRequestError('customerId es requerido')
  }
  if (!Number.isFinite(input.amountCents) || input.amountCents <= 0) {
    throw new BadRequestError('amountCents es requerido')
  }

  const since = new Date(Date.now() - 15 * 60 * 1000)
  const amount = new Prisma.Decimal(input.amountCents / 100)
  const tipAmount = new Prisma.Decimal((input.tipCents || 0) / 100)
  const processedById = input.staffId?.trim() || undefined

  const payment = await prisma.payment.findFirst({
    where: {
      venueId,
      status: 'COMPLETED',
      amount,
      tipAmount,
      ...(processedById ? { processedById } : {}),
      createdAt: { gte: since },
    },
    orderBy: {
      createdAt: 'desc',
    },
    select: {
      id: true,
      orderId: true,
    },
  })

  if (!payment) {
    throw new NotFoundError('Payment not found')
  }

  return attachCustomerToOrder(venueId, payment.orderId, normalizedCustomerId, input.actorStaffId)
}

/**
 * 🔴 BAJO-3 (full-testing, 15-oct-2026) + M1 (ronda 1): dos «Agregar cliente» del MISMO cliente a la vez leían «sin liga» y los
 * dos creaban: el segundo chocaba con un único (P2002) y respondía 500. Ante CUALQUIER choque se relee la liga (no se decide
 * por el índice que reportó Postgres: ver `ligaDeClienteEnVenta.ts`): si este cliente ya quedó ligado, se reintenta (la
 * relectura ve la liga de la otra llamada) y sigue como éxito; si no (el primario de OTRO cliente a la vez), sube como antes.
 * El tope sólo evita un ciclo si la liga aparece y desaparece.
 */
const INTENTOS_DE_LIGA = 3

/**
 * Liga un cliente a una venta (la del «Agregar cliente» después de cobrar) y, si la venta ya se cobró, le da su sello
 * tardío (spec 2026-10-14 §3.1). Devuelve los campos de orden de siempre más `loyalty` (`SaleStampOutcome | null`, campo
 * nuevo y opcional para las apps: `null` = no pintar nada).
 *
 * Idempotente ante el mismo cliente agregado varias veces (BAJO-3): una sola liga, ningún 500, y la fila de auditoría sólo
 * desde la llamada que CREÓ (o promovió a primario) la liga (`ligaNueva`).
 */
export async function attachCustomerToOrder(venueId: string, orderId: string, customerId: string, staffId?: string | null) {
  const normalizedCustomerId = customerId?.trim()

  if (!normalizedCustomerId) {
    throw new BadRequestError('customerId es requerido')
  }

  const [order, customer] = await Promise.all([
    prisma.order.findFirst({
      where: {
        id: orderId,
        venueId,
      },
      select: {
        id: true,
        orderNumber: true,
      },
    }),
    prisma.customer.findUnique({
      where: { id: normalizedCustomerId },
      select: {
        id: true,
        venueId: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
      },
    }),
  ])

  if (!order) {
    throw new NotFoundError('Order not found')
  }
  if (!customer || customer.venueId !== venueId) {
    throw new NotFoundError('Customer not found')
  }

  const displayName = customerDisplayName(customer)

  // Import dinámico, como `loyaltyOnPaidOrder` en `payCashOrder`; ANTES de abrir la transacción, para no cargar módulos con el
  // candado de la fila de la orden tomado.
  const { reabrirLealtadSiAplica, awardLoyaltyForLateCustomer } = await import('@/services/shared/loyaltyOnLateCustomer')

  const ligarEnTransaccion = () =>
    prisma.$transaction(async tx => {
      // 🔴 Ronda 1 (F1/F3): PRIMERA sentencia, el candado de la venta — el MISMO que toman la liga de la TPV, quitar cliente,
      // editar invitado y `/fast` (el cobro toma el `FOR UPDATE` canónico, que choca con éste). Sin él, una liga del POS (inserta
      // la liga y luego escribe la venta) y una de la TPV (candado de la venta y luego la liga) se tomaban los candados en orden
      // inverso y Postgres mataba a una por bloqueo mutuo (40P01), medido con 3 POS + 3 TPV.
      // R3-2 (ronda 3): `FOR NO KEY UPDATE` (`bloquearVentaParaLiga`): serializa contra el cobro y las demás ligas sin
      // interbloquearse con el `FOR KEY SHARE` de las llaves foráneas (las métricas del cobro).
      if (!(await bloquearVentaParaLiga(tx, { venueId, orderId }))) throw new NotFoundError('Order not found')
      const existingAssociation = await tx.orderCustomer.findUnique({
        where: {
          orderId_customerId: {
            orderId,
            customerId: normalizedCustomerId,
          },
        },
      })

      const hasPrimaryCustomer = await tx.orderCustomer.findFirst({
        where: {
          orderId,
          isPrimary: true,
        },
        select: { id: true },
      })

      // BAJO-3: ¿ESTA llamada creó la liga (o la promovió a primario)? Sólo ésa audita.
      let ligaNueva = false
      if (!existingAssociation) {
        await tx.orderCustomer.create({
          data: {
            orderId,
            customerId: normalizedCustomerId,
            isPrimary: !hasPrimaryCustomer,
          },
        })
        ligaNueva = true
      } else if (!hasPrimaryCustomer && !existingAssociation.isPrimary) {
        // Condicional (`isPrimary: false`): si otra llamada simultánea ya la promovió, ésta espera su candado de fila, relee y
        // no toca nada (count 0) — así sólo UNA cuenta como la que promovió.
        const promovida = await tx.orderCustomer.updateMany({
          where: { id: existingAssociation.id, isPrimary: false },
          data: { isPrimary: true },
        })
        ligaNueva = promovida.count === 1
      }

      const ligada = await tx.order.update({
        where: { id: orderId },
        data: {
          customerId: normalizedCustomerId,
          customerName: displayName,
          customerPhone: customer.phone || null,
          customerEmail: customer.email || null,
        },
        select: {
          id: true,
          orderNumber: true,
          customerId: true,
          customerName: true,
          customerPhone: true,
          customerEmail: true,
          // R3-1: el hecho «venta cobrada», leído bajo el candado, para la auditoría del sello tardío. No va en la respuesta.
          paymentStatus: true,
        },
      })

      // 🔴 Auditoría A #1: en la MISMA transacción que la liga se reabre el trabajo durable de lealtad de la venta
      // (`loyaltyProcessedAt = null`, …) si es elegible y ESTE cliente quedó como primario. Si el intento inmediato de abajo
      // falla, el reconciliador de siempre la termina. Sin esto, la venta —cobrada sin cliente y ya «procesada»— no volvía a la
      // cola nunca y el sello se perdía otra vez, en silencio. Si falla, la liga falla entera y el cajero reintenta: nunca queda
      // una liga sin su trabajo de lealtad reabierto.
      // 🔴 Y es la ÚLTIMA escritura antes del commit (ruling tras la medición de S3b): la reapertura deja una MARCA en la fila
      // (`loyaltyLastError`). La lealtad del cobro que leyó la venta «sin cliente» puede estar esperando el candado de esta fila
      // para cerrarla; al soltarse, Postgres sólo relee las columnas de la fila, y la marca es lo que la detiene.
      // H5: con el actor de la liga, para que el reconciliador selle a nombre de quien agregó al cliente.
      await reabrirLealtadSiAplica(tx, { venueId, orderId, customerId: normalizedCustomerId, staffId: staffId ?? null })

      const { paymentStatus, ...respuesta } = ligada
      // «Cobrada» por la regla compartida, con el estado leído bajo este candado.
      return { ligada: respuesta, ligaNueva, ventaCobrada: esVentaYaCobrada({ paymentStatus }) }
    }, ORDER_LOCK_WAIT_BUDGET)

  let liga: Awaited<ReturnType<typeof ligarEnTransaccion>> | undefined
  for (let intento = 1; !liga; intento++) {
    try {
      liga = await ligarEnTransaccion()
    } catch (error) {
      // 🔴 BAJO-3 + M1: otra llamada ligó a ESTE cliente mientras ésta lo intentaba: ya está ligado. Se reintenta (la
      // transacción entera se revirtió) y la relectura ve la liga de la otra; nunca un 500 por un doble toque.
      // R3-2 (ronda 3), como defensa: un interbloqueo (40P01) también se reintenta, acotado. Lo demás sube como antes.
      const motivo = motivoDeReintentoDeLiga(error)
      const reintenta =
        intento < INTENTOS_DE_LIGA &&
        ((motivo === 'UNICO' && esChoqueDeUnico(error) && (await clienteYaLigadoALaVenta(orderId, normalizedCustomerId))) ||
          motivo === 'INTERBLOQUEO')
      if (reintenta) {
        logger.warn(
          `⚠️ [ORDER.MOBILE] ${etiquetaDeReintento(motivo!)} linking customer ${normalizedCustomerId} to order ${orderId}; retrying`,
        )
        continue
      }
      throw error
    }
  }
  const { ligada: result, ligaNueva, ventaCobrada } = liga

  logger.info(`✅ [ORDER.MOBILE] Customer attached to payment order | order=${order.orderNumber} | customer=${normalizedCustomerId}`)

  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastToVenue(venueId, SocketEventType.ORDER_UPDATED, {
      orderId,
      orderNumber: order.orderNumber,
      customerId: normalizedCustomerId,
      customerName: displayName,
    })
  }

  // 🎁 Sello TARDÍO (spec 2026-10-14 §3.1): este es el «Agregar cliente» de «Cobro exitoso». La lealtad de la venta ya corrió
  // al cobrar —sin cliente— y nunca volvía. Después del commit de la liga: si algo de aquí falla, la liga ya quedó (y la
  // venta quedó reabierta para el reconciliador) y la respuesta sale igual con `loyalty: null`. El helper nunca lanza; el
  // try/catch es la última red.
  let loyalty: SaleStampOutcome | null = null
  try {
    loyalty = await awardLoyaltyForLateCustomer({
      venueId,
      orderId,
      customerId: normalizedCustomerId,
      staffId: staffId ?? null,
      ligaNueva,
      ventaCobrada,
    })
  } catch (error) {
    logger.error('[ORDER.MOBILE] Sello tardío falló (la liga del cliente ya quedó)', {
      orderId,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  return { ...result, loyalty }
}

/**
 * Cancel an unpaid order
 *
 * @param venueId Venue ID
 * @param orderId Order ID
 * @param reason Cancellation reason
 */
export async function cancelOrderInTransaction(
  tx: Prisma.TransactionClient,
  venueId: string,
  orderId: string,
  reason?: string,
  performedBy?: string,
  /** Huella del reducer offline: corre DENTRO de la transacción de la cancelación (plan 2026-10-13-sync-retoma-por-llave). */
  dentroDeLaTx?: (tx: Prisma.TransactionClient, cancelada: { orderId: string }) => Promise<void>,
) {
  logger.info(`📱 [ORDER.MOBILE] Cancelling order ${orderId} | venue=${venueId} | reason=${reason || 'none'}`)
  let scope: Awaited<ReturnType<typeof lockTableOrderScope>>
  try {
    // Existing kitchen advisory precedes all shared Order locks, including captured siblings.
    scope = await lockTableOrderScope(tx, { venueId, orderIds: [orderId], kdsOrderIds: [orderId] })
  } catch (error) {
    if (error instanceof NotFoundError && error.message === 'Venue not found') throw new NotFoundError('Order not found')
    throw error
  }
  const kds = await retirarComandasDeVentaAnulada(tx, venueId, orderId, { staffId: performedBy, reason })
  await assertOrderCancellableUnderLock(tx, { venueId, orderId })
  const removed = await tx.order.update({
    where: { id: orderId },
    data: { status: 'CANCELLED', ...(reason ? { specialRequests: `Cancelled: ${reason}` } : {}) },
    select: { tableId: true },
  })
  // Spec § 5.1.8: una cuenta de tarjetas cancelada ANTES de cobrarse deja sus sobres DEACTIVATED sin activarse.
  // Para cualquier otra cuenta es una consulta que no encuentra sobres.
  await desactivarSobresPendientesDeCuentaEnTx(tx, { venueId, orderId, staffId: performedBy ?? null })
  await dentroDeLaTx?.(tx, { orderId })
  const boundTable = scope.tables.find(table => table.currentOrderId === orderId)
  const { reconcileTableAfterOrderRemovedInTransaction } = await import('../tpv/table.tpv.service')
  const reconciled = await reconcileTableAfterOrderRemovedInTransaction(tx, scope, orderId)
  const ownTable = reconciled.tables.find(table => table.id === removed.tableId)
  const table = reconciled.tables.find(row => row.id === boundTable?.id) ?? ownTable ?? null
  const tpvTableFreed = Boolean(ownTable?.status === 'AVAILABLE' && ownTable.currentOrderId === null)
  const affectedRefs: HttpEnvelope['affectedRefs'] = [
    { kind: 'Order', id: orderId },
    ...reconciled.tables.map(row => ({ kind: 'Table' as const, id: row.id })),
    ...kds.kdsOrderIds.map(id => ({ kind: 'KdsOrder' as const, id })),
    ...kds.kdsOrderItemIds.map(id => ({ kind: 'KdsOrderItem' as const, id })),
  ]
  return { orderId, table, tables: reconciled.tables, hadBoundTable: Boolean(boundTable), tpvTableFreed, affectedRefs }
}

export async function publishCancelledOrder(
  venueId: string,
  result: Awaited<ReturnType<typeof cancelOrderInTransaction>>,
  staffId?: string,
  reason?: string,
): Promise<void> {
  const { orderId, table } = result
  logger.info(`✅ [ORDER.MOBILE] Order ${orderId} cancelled`)
  const { onOrderCancelled } = await import('@/services/referrals/referralRefund.service')
  await onOrderCancelled({ orderId, venueId })
  const broadcastingService = socketManager.getBroadcastingService()
  if (result.hadBoundTable && table) {
    logger.info(
      table.currentOrderId
        ? `✅ [ORDER.MOBILE] Table ${table.number} repointed to sibling check after cancellation`
        : `✅ [ORDER.MOBILE] Table ${table.number} released after order cancellation`,
    )
  } else {
    for (const row of result.tables) {
      logger.info(`✅ [TABLE SERVICE] Table ${row.number} reconciled after order removal`)
      if (broadcastingService)
        broadcastingService.broadcastToVenue(venueId, SocketEventType.TABLE_STATUS_CHANGE, {
          tableId: row.id,
          tableNumber: row.number,
          status: row.status,
          orderId: row.currentOrderId,
          orderNumber: null,
          covers: null,
          waiter: null,
        })
    }
  }
  const { logAction } = await import('../dashboard/activity-log.service')
  void logAction({ action: 'ORDER_CANCELLED', entity: 'Order', entityId: orderId, staffId, venueId, data: { reason: reason ?? null } })
  if (broadcastingService) {
    broadcastingService.broadcastToVenue(venueId, SocketEventType.ORDER_UPDATED, { orderId, status: 'CANCELLED' })
    // Preserve the original bound-pointer notification DTO; no fresh DB reconstruction.
    if (result.hadBoundTable && table)
      broadcastingService.broadcastToVenue(venueId, SocketEventType.TABLE_STATUS_CHANGE, {
        tableId: table.id,
        tableNumber: table.number,
        status: 'AVAILABLE',
        orderId: null,
        orderNumber: null,
      })
  }
}

export async function cancelOrder(
  venueId: string,
  orderId: string,
  reason?: string,
  performedBy?: string,
  dentroDeLaTx?: (tx: Prisma.TransactionClient, cancelada: { orderId: string }) => Promise<void>,
): Promise<void> {
  const result = await prisma.$transaction(
    tx => cancelOrderInTransaction(tx, venueId, orderId, reason, performedBy, dentroDeLaTx),
    ORDER_LOCK_WAIT_BUDGET,
  )
  await publishCancelledOrder(venueId, result, performedBy, reason)
}

export interface StampRewardOnOrderResult {
  applied: boolean
  discountAmount?: number
  rewardLabel?: string
  /** Por qué no se aplicó. El cajero tiene que poder verlo. */
  reason?: string
}

/**
 * Aplica el premio de una cartilla a una orden RECIÉN creada.
 *
 * 🔴 DINERO, y el MOMENTO es lo que importa. El punto de venta cobra el total que le
 * devuelve el servidor, no el que calculó el carrito (`adoptarTotalDelServer`), así que
 * el descuento tiene que existir antes de que ese total viaje al aparato. Con dos
 * llamadas separadas —crear la orden y luego canjear— queda una ventana en la que la
 * cuenta existe con el total completo, y si el cobro entra ahí el cliente paga de más.
 *
 * 🔴 Un premio que no se puede aplicar NO tumba la venta, pero TAMPOCO se ignora en
 * silencio. Tumbarla dejaría al cajero sin poder cobrar por culpa de un premio;
 * ignorarla dejaría al cliente pagando completo sin que nadie se entere. La única
 * salida honesta es cobrar el total real y decir por qué no se aplicó.
 */
export async function applyStampRewardToNewOrder(
  venueId: string,
  orderId: string,
  stampRewardId: string | null | undefined,
  staffId?: string,
  expectedDiscountCents?: number | null,
): Promise<StampRewardOnOrderResult> {
  // El caso normal: la inmensa mayoría de las ventas no trae premio, y no puede costar
  // ni una consulta de más.
  if (!stampRewardId) return { applied: false }

  let result: StampRewardOnOrderResult
  try {
    const { redeemStampReward } = await import('../wallet/redeemStampReward.service')
    const r = await redeemStampReward(venueId, orderId, stampRewardId, { staffId })
    result = { applied: true, discountAmount: r.discountAmount, rewardLabel: r.rewardLabel }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    logger.warn('No se pudo aplicar el premio a una venta nueva', { venueId, orderId, stampRewardId, reason })
    result = { applied: false, reason }
  }

  await traceStampRewardMismatch(venueId, orderId, stampRewardId, staffId, expectedDiscountCents, result)
  return result
}

/**
 * 🔴 La caja descontó el premio al calcular lo que cobra y el servidor no lo confirmó igual: la
 * cuenta queda con una diferencia. Nada se descarta en silencio: queda en la bitácora.
 */
async function traceStampRewardMismatch(
  venueId: string,
  orderId: string,
  stampRewardId: string,
  staffId: string | undefined,
  expectedDiscountCents: number | null | undefined,
  result: StampRewardOnOrderResult,
): Promise<void> {
  const confirmedCents = result.applied ? Math.round((result.discountAmount ?? 0) * 100) : 0
  if (typeof expectedDiscountCents !== 'number' || expectedDiscountCents <= 0 || confirmedCents === expectedDiscountCents) return
  void (await import('../dashboard/activity-log.service')).logAction({
    action: 'STAMP_REWARD_NOT_AS_CHARGED',
    entity: 'Order',
    entityId: orderId,
    staffId,
    venueId,
    data: { stampRewardId, expectedCents: expectedDiscountCents, confirmedCents, reason: result.reason ?? null },
  })
}

/**
 * La caja reintentó la creación (perdió la respuesta, o dos intentos se cruzaron) y la orden ya
 * existe. Si el premio todavía no quedó en ella —el primer intento se cayó antes de canjearlo— se
 * canjea AHORA; el canje es condicional, así que sólo un intento lo quema. Se responde lo que de
 * verdad quedó en la orden, nunca un «no aplicado» por haber llegado segundo.
 */
export async function ensureStampRewardOnExistingOrder(
  venueId: string,
  orderId: string,
  stampRewardId: string,
  staffId?: string,
  expectedDiscountCents?: number | null,
): Promise<StampRewardOnOrderResult> {
  const yaAplicado = await stampRewardOutcomeForExistingOrder(venueId, orderId)
  let result = yaAplicado
  if (!yaAplicado.applied) {
    // Sin rastro aquí: se decide con el resultado FINAL, abajo.
    const intento = await applyStampRewardToNewOrder(venueId, orderId, stampRewardId, staffId)
    if (intento.applied) {
      result = intento
    } else {
      // Perdió la carrera: el otro intento lo canjeó en ESTA orden mientras tanto.
      const despues = await stampRewardOutcomeForExistingOrder(venueId, orderId)
      result = despues.applied ? despues : intento
    }
  }
  await traceStampRewardMismatch(venueId, orderId, stampRewardId, staffId, expectedDiscountCents, result)
  return result
}

/**
 * Qué pasó con el premio de una orden que YA existía (la caja reintentó la creación con la
 * misma `externalId`). Se lee de la base, no se vuelve a canjear.
 */
export async function stampRewardOutcomeForExistingOrder(venueId: string, orderId: string): Promise<StampRewardOnOrderResult> {
  // JOIN directo por la orden: listar sus descuentos con tope podía dejar el premio fuera.
  const filas = await prisma.$queryRaw<{ rewardLabel: string; amount: Prisma.Decimal | number }[]>`
    SELECT sr."rewardLabel", od."amount"
    FROM "StampReward" sr
    JOIN "OrderDiscount" od ON od."id" = sr."orderDiscountId"
    WHERE od."orderId" = ${orderId} AND sr."venueId" = ${venueId}
    LIMIT 1`
  const premio = filas[0]
  if (!premio) {
    return { applied: false, reason: 'El premio no quedó aplicado a esta venta.' }
  }
  return { applied: true, discountAmount: Number(premio.amount), rewardLabel: premio.rewardLabel }
}
