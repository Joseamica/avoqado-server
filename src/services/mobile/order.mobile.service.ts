/**
 * Mobile Order Service
 *
 * Order management for mobile apps (iOS, Android).
 * Creates orders with items for the dual-mode payment flow:
 * - Quick Payment (FastPayment): No order, just amount
 * - Order Payment: Create order first, then pay via TPV
 */

import { Prisma } from '@prisma/client'
import socketManager from '../../communication/sockets'
import { SocketEventType } from '../../communication/sockets/types'
import logger from '../../config/logger'
import { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { validateStaffVenue } from '../../utils/staff-venue.util'
import { generateAndStoreReceipt } from '../dashboard/receipt.dashboard.service'
import { resolveTenderForCharge, computeTenderCommission } from '../dashboard/tenderType.dashboard.service'
// Reuse the SAME helpers the TPV order/fast endpoints use so the mobile cash
// response carries an identical `digitalReceipt` shape — mobile and TPV never
// drift on how the receipt QR (accessKey + receiptUrl + autofactura) is built.
import { mapDigitalReceiptResponse, resolveAutofacturaAvailable, type OrderInventoryWarning } from '../tpv/payment.tpv.service'
import {
  buildItemDiscountRow,
  calculateDiscountPesos,
  validateDiscountActive,
  validateDiscountScopeForItem,
} from '../shared/discount.service'
import { applyPromotionToOrder, removeIntentPromotions } from '../promotions/promotion.service'
import { assertVenueSalesEnabled } from '../venueSalesGuard'

// MARK: - Types

export interface CreateOrderItemInput {
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
    selections: Array<{ groupId: string; optionId: string }>
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
}

export interface CreatedOrderResponse {
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
  discountAmount: number
  tipAmount: number
  total: number
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
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.order.count({ where }),
  ])

  const data: OrderSummaryResponse[] = orders.map((order: any) => ({
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
  }))

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
}> {
  // Validate items array
  if (!items || items.length === 0) {
    throw new BadRequestError('At least one item is required')
  }

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
  return { itemsData, subtotal, itemDiscountTotal, discounts }
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
  let order
  try {
    order = await prisma.$transaction(async tx => {
      const createdOrder = await tx.order.create({
        data: {
          venueId,
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
      if (discountedItems.length > 0) {
        const appliedByStaffVenue = validatedStaffId
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
      }

      return createdOrder
    })
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

  // Las promociones se aplican sobre la orden YA creada, con el MISMO servicio
  // transaccional que usa el reducer offline (applyAddItems): crea sus líneas,
  // reparte el descuento al centavo y RECALCULA los totales de la orden. Va
  // ANTES del broadcast para que el evento lleve el total con el combo dentro.
  if (promocionesUnicas.length > 0) {
    const orderId = order.id
    const instanceIds = promocionesUnicas.map(ref => ref.promotionInstanceId)
    try {
      for (const ref of promocionesUnicas) {
        await applyPromotionToOrder({
          venueId,
          orderId,
          promotionId: ref.promotionId,
          instanceId: ref.promotionInstanceId,
          selections: ref.selections,
          // Venta EN LÍNEA: el instante es ahora. El acotado de reloj
          // (clampSoldAt) es del camino offline, donde el cliente propone la hora.
          soldAt: new Date(),
        })
      }
    } catch (error) {
      // 🔴 Todo-o-nada, igual que el reducer: cada promoción commitea en SU
      // propia transacción, así que si la #2 truena la #1 ya quedó viva. Y aquí
      // nadie la va a reintentar — un retry del POS con el mismo externalId
      // entra por el corto de idempotencia y devolvería esa orden a medias, con
      // un combo cobrado y el otro no. Se retiran las de ESTA venta (best-effort,
      // por instanceId) y se propaga el error original.
      //
      // 🔴 La compensación NUNCA puede sustituir al error original: su primera
      // sentencia es una query, así que si lo que tronó fue la DB, la
      // compensación truena también y el cajero perdería el único texto
      // accionable ("Esa promoción no está publicada.", "Falta elegir una
      // opción de …") a cambio de un error crudo de Prisma.
      try {
        await removeIntentPromotions(venueId, orderId, instanceIds)
      } catch (compensationError) {
        logger.error('❌ [ORDER.MOBILE] Falló la compensación de promociones — se conserva el error original', {
          orderId,
          instanceIds,
          compensationError: compensationError instanceof Error ? compensationError.message : String(compensationError),
        })
      }

      // 🔴 La llave de idempotencia NO puede quedar envenenada. `order.create`
      // YA commiteó, así que si salimos con un 4xx y el POS corrige y reintenta
      // con el MISMO externalId —que es exactamente para lo que existe—, el
      // corto de idempotencia le devolvería 201 con ESTA orden, sin el combo:
      // en una venta de puras promociones vale $0 y el combo sale gratis; en
      // una mixta se cobra sólo lo suelto. Y es DURABLE, no una carrera: todos
      // los reintentos futuros con esa llave repetirían la venta incompleta.
      //
      // Se libera la llave Y se anula la orden. Sólo soltar el externalId
      // dejaría una cuenta viva de $0 en el piso; sólo anularla dejaría la
      // llave tomada y el reintento chocaría contra el corto igual.
      // Best-effort: nada de esto puede sustituir al error de negocio original.
      try {
        await prisma.order.update({
          where: { id: orderId },
          data: {
            externalId: null,
            status: 'CANCELLED',
            specialRequests: 'Cancelled: la promoción no se pudo aplicar',
          },
        })
      } catch (cleanupError) {
        logger.error('❌ [ORDER.MOBILE] No se pudo liberar la llave de una orden con promoción fallida', {
          orderId,
          externalId,
          cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        })
      }
      throw error
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
    // Aquí se reafirman los términos que este endpoint sí conoce. No se toca la
    // función compartida (la usan comp/split/descuentos), y una venta SIN
    // promociones nunca pasa por aquí: sigue comportándose igual que siempre.
    const recalculada = await prisma.order.findFirst({
      where: { id: orderId, venueId },
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
    order = await prisma.order.update({
      where: { id: orderId },
      data: {
        discountAmount: new Prisma.Decimal(descuentoFinal),
        total: new Prisma.Decimal(totalFinal),
        remainingBalance: new Prisma.Decimal(remainingFinal),
        version: { increment: 1 },
      },
      include: createdOrderInclude,
    })
    logger.info(
      `🎁 [ORDER.MOBILE] ${promocionesUnicas.length} promoción(es) aplicadas | order=${orderId} | subtotal=${subtotalConPromociones} | descuento=${descuentoFinal} | propina=${tipDecimal} | total=${totalFinal}`,
    )
  }

  // Emit Socket.IO event for real-time order creation
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastToVenue(venueId, SocketEventType.ORDER_CREATED, {
      orderId: order.id,
      orderNumber: order.orderNumber,
      orderType: order.type,
      source: order.source,
      total: Number(order.total),
    })
  }

  // Flatten and return response
  return toCreatedOrderResponse(order)
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
          processedBy: {
            select: { firstName: true, lastName: true },
          },
        },
      },
      orderDiscounts: {
        select: { id: true, name: true, amount: true },
      },
    },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  // Flatten modifiers for mobile response
  const flattenedOrder = flattenOrderModifiers(order)

  return {
    id: flattenedOrder.id,
    orderNumber: flattenedOrder.orderNumber,
    status: flattenedOrder.status,
    paymentStatus: flattenedOrder.paymentStatus,
    type: flattenedOrder.type,
    source: flattenedOrder.source,
    subtotal: Number(flattenedOrder.subtotal),
    taxAmount: Number(flattenedOrder.taxAmount),
    discountAmount: Number(flattenedOrder.discountAmount),
    tipAmount: Number(flattenedOrder.tipAmount),
    total: Number(flattenedOrder.total),
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

/**
 * TABLE_SERVICE — partial update of the check's details. Only provided keys
 * change; everything is additive metadata (never money).
 */
export async function updateOrderDetails(venueId: string, orderId: string, input: OrderDetailsInput) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, venueId },
    select: { id: true, status: true, customerName: true },
  })
  if (!order) throw new NotFoundError('Order not found')
  if (['COMPLETED', 'CANCELLED', 'DELETED'].includes(order.status)) {
    throw new BadRequestError('La cuenta ya está cerrada')
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
      const customer = await prisma.customer.findFirst({
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

  const updated = await prisma.order.update({
    where: { id: order.id },
    data,
    select: { customerName: true, specialRequests: true, covers: true, customerId: true, type: true },
  })

  // Cambiar el conteo de comensales puede disparar (o retirar) la propina
  // automática por grupo — el cargo debe seguir al conteo, no quedarse pegado.
  if (input.covers != null) {
    const { syncAutomaticServiceCharges } = await import('./service-charge.mobile.service')
    await syncAutomaticServiceCharges(venueId, orderId)
  }

  return {
    name: updated.customerName,
    notes: updated.specialRequests,
    covers: updated.covers,
    customerId: updated.customerId,
    orderType: updated.type,
  }
}

// MARK: - Table order discounts (check panel "Descuentos")

/**
 * TABLE_SERVICE — applies a catalog ORDER-scope discount to the open check
 * and recomputes totals (same recalc the comp path uses, so % discounts
 * re-derive consistently).
 */
export async function applyOrderDiscount(venueId: string, orderId: string, discountId: string, staffId?: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, venueId },
    select: { id: true, paymentStatus: true, discountAmount: true, paidAmount: true, subtotal: true },
  })
  if (!order) throw new NotFoundError('Order not found')
  if (order.paymentStatus === 'PAID' || order.paymentStatus === 'PARTIAL') {
    throw new BadRequestError('No se puede descontar una orden ya pagada')
  }

  const discount = await prisma.discount.findFirst({ where: { id: discountId, venueId } })
  if (!discount) throw new NotFoundError('Descuento no encontrado')
  validateDiscountActive(discount)
  if (discount.scope !== 'ORDER') {
    throw new BadRequestError('Solo descuentos de orden aplican a la cuenta completa')
  }

  const dup = await prisma.orderDiscount.findFirst({ where: { orderId, discountId } })
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
  const amount = Math.min(rawAmount, remainingDiscountable)

  const row = await prisma.orderDiscount.create({
    data: {
      orderId,
      discountId,
      type: discount.type,
      name: discount.name,
      value: discount.value,
      amount,
    },
    select: { id: true, name: true, amount: true },
  })

  const { recalculateOrderTotals } = await import('./comp-item.mobile.service')
  const totals = await recalculateOrderTotals(orderId, 0, Number(order.paidAmount || 0))

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
export async function removeOrderDiscount(venueId: string, orderId: string, orderDiscountId: string, staffId?: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, venueId },
    select: { id: true, paymentStatus: true, paidAmount: true },
  })
  if (!order) throw new NotFoundError('Order not found')
  if (order.paymentStatus === 'PAID' || order.paymentStatus === 'PARTIAL') {
    throw new BadRequestError('No se puede modificar una orden ya pagada')
  }

  const row = await prisma.orderDiscount.findFirst({ where: { id: orderDiscountId, orderId } })
  if (!row) throw new NotFoundError('Descuento no aplicado a esta orden')

  // 🔴 MONEY: a discount that came from redeeming loyalty points must give the
  // points BACK when it is removed — otherwise the customer paid with points
  // for a discount that no longer exists. Both moves share one transaction.
  const { refundLoyaltyForOrderDiscount } = await import('./loyalty.mobile.service')
  const { recalculateOrderTotals } = await import('./comp-item.mobile.service')
  const { refund, totals } = await prisma.$transaction(async tx => {
    const refunded = await refundLoyaltyForOrderDiscount(tx, venueId, row, staffId)
    await tx.orderDiscount.delete({ where: { id: row.id } })
    const t = await recalculateOrderTotals(orderId, 0, Number(order.paidAmount || 0), tx)
    return { refund: refunded, totals: t }
  })

  void (await import('../dashboard/activity-log.service')).logAction({
    action: 'ORDER_DISCOUNT_REMOVED',
    entity: 'Order',
    entityId: orderId,
    staffId,
    venueId,
    data: { orderDiscountId, name: row.name, pointsRefunded: refund?.pointsRefunded ?? 0 },
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
export async function splitOrderItems(venueId: string, orderId: string, itemIds: string[], staffId?: string) {
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    throw new BadRequestError('itemIds es requerido')
  }

  const source = await prisma.order.findFirst({
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
      items: { select: { id: true, orderPromotionId: true } },
      orderDiscounts: { select: { id: true } },
      serviceCharges: { select: { id: true, isAutomatic: true } },
    },
  })
  if (!source) throw new NotFoundError('Order not found')
  if (['COMPLETED', 'CANCELLED', 'DELETED'].includes(source.status)) {
    throw new BadRequestError('La cuenta ya está cerrada')
  }
  if (source.paymentStatus === 'PAID' || source.paymentStatus === 'PARTIAL') {
    throw new BadRequestError('No se puede separar una cuenta ya pagada')
  }
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

  // 🔴 Atómico (auditoría): crear + mover + AMBOS recálculos en UNA transacción.
  // Un crash a medias dejaría el origen sobre-cobrando los items ya movidos.
  const { recalculateOrderTotals } = await import('./comp-item.mobile.service')
  const { newOrder, sourceTotals, newTotals } = await prisma.$transaction(async tx => {
    const created = await tx.order.create({
      data: {
        venueId,
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
    return { newOrder: created, sourceTotals: src, newTotals: dst }
  })

  void (await import('../dashboard/activity-log.service')).logAction({
    action: 'ORDER_SPLIT',
    entity: 'Order',
    entityId: source.id,
    staffId,
    venueId,
    data: { newOrderId: newOrder.id, newOrderNumber: newOrder.orderNumber, items: toMove.length },
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
export async function splitOrderBySeat(venueId: string, orderId: string, staffId?: string) {
  const source = await prisma.order.findFirst({
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
      items: { select: { id: true, seat: true } },
      orderDiscounts: { select: { id: true } },
      serviceCharges: { select: { id: true, isAutomatic: true } },
    },
  })
  if (!source) throw new NotFoundError('Order not found')
  if (['COMPLETED', 'CANCELLED', 'DELETED'].includes(source.status)) {
    throw new BadRequestError('La cuenta ya está cerrada')
  }
  if (source.paymentStatus === 'PAID' || source.paymentStatus === 'PARTIAL') {
    throw new BadRequestError('No se puede dividir una cuenta ya pagada')
  }
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

  const { recalculateOrderTotals } = await import('./comp-item.mobile.service')
  const created = await prisma.$transaction(async tx => {
    const results: Array<{ id: string; orderNumber: string; seat: number }> = []
    for (const seat of seatsToMove) {
      const itemIds = bySeat.get(seat) as string[]
      const newOrder = await tx.order.create({
        data: {
          venueId,
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
        },
        select: { id: true, orderNumber: true },
      })
      await tx.orderItem.updateMany({
        where: { id: { in: itemIds }, orderId: source.id },
        data: { orderId: newOrder.id },
      })
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
    return { results: totalsPerSeat, sourceTotals: src }
  })

  const createdTotals = created.results
  const sourceTotals = created.sourceTotals

  void (await import('../dashboard/activity-log.service')).logAction({
    action: 'ORDER_SPLIT_BY_SEAT',
    entity: 'Order',
    entityId: source.id,
    staffId,
    venueId,
    data: { seats: seatsToMove, created: created.results.length },
  })

  return {
    source: { id: source.id, orderNumber: source.orderNumber, total: sourceTotals.total, seat: seats[0] },
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
export async function mergeOrders(venueId: string, targetOrderId: string, sourceOrderId: string, staffId?: string) {
  if (targetOrderId === sourceOrderId) {
    throw new BadRequestError('No se puede fusionar una cuenta consigo misma')
  }

  const [target, source] = await Promise.all([
    prisma.order.findFirst({
      where: { id: targetOrderId, venueId },
      select: { id: true, orderNumber: true, status: true, paymentStatus: true, paidAmount: true, tableId: true },
    }),
    prisma.order.findFirst({
      where: { id: sourceOrderId, venueId },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        paymentStatus: true,
        tableId: true,
        customerName: true,
        items: { select: { id: true } },
        orderDiscounts: { select: { id: true } },
        serviceCharges: { select: { id: true, isAutomatic: true } },
      },
    }),
  ])
  if (!target) throw new NotFoundError('Cuenta destino no encontrada')
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

  if (source.items.length === 0) {
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
  const mergedTotals = await prisma.$transaction(async tx => {
    // 🔴 Revalidar DENTRO de la tx (auditoría): entre el guard y la tx pudo
    // entrar un pago, un descuento, o una fusión cruzada A→B / B→A. Sin esto,
    // dos merges concurrentes pueden cancelar AMBAS cuentas con los items
    // varados en una cuenta cancelada.
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
        orderDiscounts: { select: { id: true } },
        serviceCharges: { select: { id: true, isAutomatic: true } },
      },
    })
    const freshTarget = await tx.order.findFirst({
      where: {
        id: target.id,
        venueId,
        status: { notIn: ['COMPLETED', 'CANCELLED', 'DELETED'] },
        paymentStatus: { notIn: ['PAID', 'PARTIAL'] },
      },
      select: { id: true, specialRequests: true },
    })
    if (!freshSource || !freshTarget) {
      throw new BadRequestError('La cuenta cambió mientras se fusionaba — vuelve a intentar')
    }
    if (freshSource.orderDiscounts.length > 0 || freshSource.serviceCharges.some(sc => !sc.isAutomatic)) {
      throw new BadRequestError('La cuenta origen recibió descuentos o cobros durante la fusión — vuelve a intentar')
    }

    await tx.orderItem.updateMany({
      where: { orderId: source.id },
      data: { orderId: target.id },
    })
    // Los cobros automáticos del origen se van con él: el destino re-evalúa
    // los suyos por comensales en el recálculo.
    await tx.orderServiceCharge.deleteMany({ where: { orderId: source.id } })

    // Las notas de cocina del origen NO se pierden: se anexan al destino.
    if (freshSource.specialRequests?.trim()) {
      await tx.order.update({
        where: { id: target.id },
        data: {
          specialRequests: [freshTarget.specialRequests, freshSource.specialRequests].filter(Boolean).join(' · '),
        },
      })
    }

    await tx.order.update({
      where: { id: source.id },
      data: {
        status: 'CANCELLED',
        specialRequests: `Fusionada en ${target.orderNumber}`,
        subtotal: 0,
        discountAmount: 0,
        serviceChargeAmount: 0,
        total: 0,
      },
    })

    return recalculateOrderTotals(target.id, 0, Number(target.paidAmount || 0), tx)
  })

  // La mesa del origen: re-apuntar a otra cuenta abierta, o liberarla.
  const boundTable = await prisma.table.findFirst({
    where: { venueId, currentOrderId: source.id },
    select: { id: true, number: true },
  })
  if (boundTable) {
    const sibling = await prisma.order.findFirst({
      where: {
        venueId,
        tableId: boundTable.id,
        id: { not: source.id },
        status: { notIn: ['COMPLETED', 'CANCELLED', 'DELETED'] },
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    })
    await prisma.table.update({
      where: { id: boundTable.id },
      data: sibling ? { status: 'OCCUPIED', currentOrderId: sibling.id } : { status: 'AVAILABLE', currentOrderId: null },
    })
  }

  const totals = mergedTotals
  // El destino puede haber cruzado el mínimo de comensales al crecer.
  const { syncAutomaticServiceCharges } = await import('./service-charge.mobile.service')
  const afterAuto = await syncAutomaticServiceCharges(venueId, target.id)

  void (await import('../dashboard/activity-log.service')).logAction({
    action: 'ORDERS_MERGED',
    entity: 'Order',
    entityId: target.id,
    staffId,
    venueId,
    data: { sourceOrderId: source.id, sourceOrderNumber: source.orderNumber, items: source.items.length },
  })

  return {
    target: {
      id: target.id,
      orderNumber: target.orderNumber,
      total: (afterAuto ?? totals).total,
      version: (afterAuto ?? totals).version,
    },
    merged: { id: source.id, orderNumber: source.orderNumber, items: source.items.length },
    tableFreed: Boolean(boundTable),
  }
}

// MARK: - Cash Payment Types

export interface CashPaymentInput {
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
   * `true` cuando la venta viene de la cola offline: ya ocurrió, así que se honra la
   * revisión que el cajero vio al cobrar en vez de exigir la vigente. Lo pone el
   * reducer (`sync.mobile.service`), NUNCA un cliente por HTTP.
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
  amount: number
  tipAmount: number
  method: 'CASH' | 'CREDIT_CARD' | 'DEBIT_CARD' | 'BANK_TRANSFER' | 'OTHER'
  status: 'COMPLETED'
  changeAmount?: number // For display purposes (calculated on iOS)
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
export async function payCashOrder(venueId: string, orderId: string, input: CashPaymentInput): Promise<CashPaymentResponse> {
  const amount = input.amount
  const tip = input.tip || 0

  logger.info(`💵 [ORDER.MOBILE] Recording cash payment | venue=${venueId} | order=${orderId} | amount=${amount} cents | tip=${tip} cents`)

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
      areaTicketCheckoutSession: { select: { id: true } },
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
      include: { receipts: true },
    })
    if (existingByKey) {
      logger.info(
        `🔄 [ORDER.MOBILE] Reintento idempotente detectado (key=${input.idempotencyKey}) — devuelvo el pago existente ${existingByKey.id}`,
      )
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
  // Sólo el efectivo entra al cajón; lo cobrado por fuera se marca como manual
  // para que el arqueo y la atribución de ingresos no lo confundan con nuestro
  // procesamiento.
  const paymentSource = paymentMethod === 'CASH' ? 'APP' : 'OTHER'
  const externalSource = paymentMethod === 'CASH' ? null : input.externalSource?.trim()?.slice(0, 50) || null

  const effectiveStaffId = await validateStaffVenue(input.staffId, venueId)

  // Find current open shift for this staff member (if any)
  let currentShift = null
  if (effectiveStaffId) {
    currentShift = await prisma.shift.findFirst({
      where: {
        venueId,
        staffId: effectiveStaffId,
        status: 'OPEN',
        endTime: null,
      },
      orderBy: { startTime: 'desc' },
    })
  }

  // Convert cents to decimal for database
  const amountDecimal = amount / 100
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
  let paymentResult:
    | {
        newPayment: any
        isFullyPaid: boolean
        areaTicketOrder: boolean
        areaTicketSessionId?: string
        postingId?: string | null
        // El saldo que la transacción YA calculó — antes se quedaba dentro y el
        // código de abajo (respuesta, broadcast, hook de referidos) tenía que
        // adivinarlo o mentir. Mismo patrón que `postingId`.
        balance: OrderBalanceSnapshot
      }
    | undefined

  for (let attempt = 1; attempt <= MAX_PAYMENT_CAS_ATTEMPTS; attempt++) {
    try {
      paymentResult = await prisma.$transaction(async tx => {
        // Vales v7 bloquean sesión → vales → orden ANTES del flujo monetario.
        // Para una orden normal devuelve null y el comportamiento queda idéntico.
        const areaTicketPayment = await import('./areaTicketV7.mobile.service')
        const lockedAreaCheckout = await areaTicketPayment.lockAreaTicketCheckoutForPayment(tx, {
          venueId,
          orderId,
          idempotencyKey: input.idempotencyKey,
          amount: new Prisma.Decimal(amountDecimal),
          method: paymentMethod,
        })

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
            version: true,
            areaTicketCode: true,
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
        const previousPayments = await tx.payment.findMany({
          where: { orderId, status: 'COMPLETED' },
          select: { amount: true, tipAmount: true },
        })
        const previousPaid = previousPayments.reduce((sum, p) => sum + Number(p.amount) + Number(p.tipAmount), 0)
        const previousTips = previousPayments.reduce((sum, p) => sum + Number(p.tipAmount), 0)

        // Convention: order.total = subtotal - discountAmount + serviceCharge + tipAmount
        // (Mexico: tax is inclusive in subtotal). Recompute defensively in case the
        // order was created before tip was known.
        const orderSubtotal = Number(fresh.subtotal)
        const orderDiscount = Number(fresh.discountAmount || 0)
        // 🔴 MONEY (auditoría): sin esto, cualquier pago parcial en efectivo BORRA
        // el cobro por servicio del total y el restante deja de cobrarlo.
        const orderServiceCharge = Number(fresh.serviceChargeAmount || 0)
        const totalTip = previousTips + tipDecimal
        // 🔴 MONEY: la MERCANCÍA se clampa a 0 ANTES de sumarle cargos y propina.
        //
        // Un `discountAmount` mayor que el subtotal es un estado que existe de
        // verdad en la base (lo dejan cortesías de cuenta completa aplicadas
        // sobre un descuento previo). Sin el clamp, COBRAR esa cuenta escribía un
        // `Order.total` NEGATIVO y la marcaba PAGADA: una venta que RESTA del
        // corte del día. Comprobado el 2026-08-09 cobrando en $0 la orden
        // ORD-1779465117373 — entró con total −300.00 y salió PAID con −300.00.
        //
        // El clamp va sobre `subtotal − descuento`, NO sobre el total completo:
        // la propina y el cargo por servicio son dinero aparte de la mercancía y
        // un descuento excedente no debe comérselos. Mismo criterio que
        // `recalculateOrderTotals` y que `recordOrderPayment` del TPV.
        const newTotal = Math.max(0, orderSubtotal - orderDiscount) + orderServiceCharge + totalTip
        const totalPaidIncludingTip = previousPaid + amountDecimal + tipDecimal
        const remainingAfterPayment = newTotal - totalPaidIncludingTip
        const isFullyPaid = remainingAfterPayment <= 0.01 // float tolerance, same as TPV path

        // 4️⃣ TRANSICIÓN CONDICIONAL (CAS). `updateMany` con la versión leída: si otro
        //    dispositivo cobró entre la relectura y este write, PostgreSQL reevalúa el
        //    WHERE contra la fila nueva, no coincide, y count = 0. Nada se escribió.
        const transition = await tx.order.updateMany({
          where: { id: orderId, venueId, version: fresh.version, paymentStatus: { in: ['PENDING', 'PARTIAL'] } },
          data: {
            paymentStatus: isFullyPaid ? 'PAID' : 'PARTIAL',
            status: isFullyPaid ? 'COMPLETED' : 'PENDING',
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

        // 5️⃣ El Payment se crea DESPUÉS de ganar la transición. Si la CAS falla, este
        //    insert nunca ocurre — que es exactamente lo que evita el segundo cobro.
        // 🔑 Semántica de dinero SERVER-OWNED: si el POS referenció un tender del
        // catálogo, el método fiscal y los snapshots salen de la revisión congelada,
        // no de lo que mandó el cliente.
        const resolvedTender =
          input.tenderTypeId != null && input.tenderRevision != null
            ? await resolveTenderForCharge(
                venueId,
                input.tenderTypeId,
                input.tenderRevision,
                tx,
                input.isOfflineReplay ? 'replay' : 'online',
              )
            : null
        tenderState.resolved = resolvedTender

        // Propina prohibida en un tender configurado sin propina: el POS no debería
        // ofrecerla, pero la frontera del sistema no confía en la UI.
        if (resolvedTender && !resolvedTender.tenderCaptureTip && tipDecimal > 0) {
          throw new BadRequestError(`El tipo de pago "${resolvedTender.tenderLabel}" no acepta propina.`)
        }

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
            processedById: effectiveStaffId,
            shiftId: currentShift?.id,
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
            ...(resolvedTender
              ? {
                  tenderTypeId: resolvedTender.tenderTypeId,
                  tenderRevision: resolvedTender.tenderRevision,
                  tenderLabel: resolvedTender.tenderLabel,
                  tenderCountsAsCash: resolvedTender.tenderCountsAsCash,
                  tenderCaptureTip: resolvedTender.tenderCaptureTip,
                  tenderSatFormaPago: resolvedTender.tenderSatFormaPago,
                  tenderCommissionPercent: resolvedTender.tenderCommissionPercent,
                  tenderCommissionAmount: computeTenderCommission(
                    resolvedTender.tenderCommissionPercent,
                    new Prisma.Decimal(amountDecimal),
                  ),
                  fundsFlow: resolvedTender.fundsFlow,
                }
              : {}),
          },
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

        // Update shift totals if there's an active shift
        if (currentShift) {
          await tx.shift.update({
            where: { id: currentShift.id },
            data: {
              totalSales: { increment: amountDecimal },
              totalTips: { increment: tipDecimal },
              totalOrders: { increment: 1 },
            },
          })
        }

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
        // Área-tickets ya dedujeron dentro de su propia finalización → SKIPPED
        // con razón durable, nunca silencio.
        let postingId: string | null = null
        if (isFullyPaid) {
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
            skipReason: areaFinalization.areaTicketOrder ? 'AREA_TICKET_TRANSACTIONAL' : undefined,
          })
          postingId = posting?.id ?? null
        }

        return {
          newPayment,
          isFullyPaid,
          areaTicketOrder: areaFinalization.areaTicketOrder,
          areaTicketSessionId: areaFinalization.sessionId,
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
        }
      })
      break // ganamos la transición
    } catch (err: any) {
      // 🛡️ Carrera IDEMPOTENTE: si dos requests con la MISMA idempotencyKey pasan
      // el findUnique de arriba (ninguna había commiteado aún), la segunda choca
      // en el índice único (P2002); la atrapamos y devolvemos el pago ganador —
      // nunca creamos un segundo Payment. ESTE CAMINO SE CONSERVA TAL CUAL.
      if (err?.code === 'P2002' && input.idempotencyKey) {
        const winner = await prisma.payment.findUnique({
          where: { venueId_idempotencyKey: { venueId, idempotencyKey: input.idempotencyKey } },
          include: { receipts: true },
        })
        if (winner) {
          logger.info(`🔄 [ORDER.MOBILE] Carrera idempotente (P2002) — devuelvo el pago ganador ${winner.id}`)
          return {
            paymentId: winner.id,
            orderId,
            orderNumber: order.orderNumber,
            // Enteros, igual que el camino idempotente de arriba.
            amount: pesosToCents(Number(winner.amount)),
            tipAmount: pesosToCents(Number(winner.tipAmount)),
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
            include: { receipts: true },
          })
          if (mine) {
            return {
              paymentId: mine.id,
              orderId,
              orderNumber: order.orderNumber,
              // Enteros, igual que los otros dos caminos idempotentes.
              amount: pesosToCents(Number(mine.amount)),
              tipAmount: pesosToCents(Number(mine.tipAmount)),
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
  const { newPayment: payment, isFullyPaid: orderFullyPaid, postingId, balance } = paymentResult

  logger.info(`✅ [ORDER.MOBILE] Cash payment recorded | paymentId=${payment.id} | order=${order.orderNumber}`)

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
  try {
    const { postCashSaleToDrawer } = await import('@/services/shared/cashDrawerPosting')
    await postCashSaleToDrawer({
      venueId,
      paymentId: payment.id,
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

  // Emit Socket.IO events for real-time updates
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastToVenue(venueId, SocketEventType.PAYMENT_COMPLETED, {
      paymentId: payment.id,
      orderId,
      orderNumber: order.orderNumber,
      amount: amountDecimal,
      tipAmount: tipDecimal,
      method: paymentMethod,
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
    amount,
    tipAmount: tip,
    method: paymentMethod,
    status: 'COMPLETED',
    digitalReceipt,
    ...(inventoryWarning ? { inventoryWarning } : {}),
    // Saldo autoritativo, en centavos enteros como el resto de esta respuesta.
    // El POS ya no tiene que deducirlo del carrito.
    ...balance,
  }
}

export async function attachCustomerToPayment(venueId: string, paymentId: string, customerId: string) {
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

  return attachCustomerToOrder(venueId, payment.orderId, normalizedCustomerId)
}

export async function attachCustomerToLatestPayment(
  venueId: string,
  input: {
    customerId: string
    amountCents: number
    tipCents?: number
    staffId?: string | null
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

  return attachCustomerToOrder(venueId, payment.orderId, normalizedCustomerId)
}

export async function attachCustomerToOrder(venueId: string, orderId: string, customerId: string) {
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

  const result = await prisma.$transaction(async tx => {
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

    if (!existingAssociation) {
      await tx.orderCustomer.create({
        data: {
          orderId,
          customerId: normalizedCustomerId,
          isPrimary: !hasPrimaryCustomer,
        },
      })
    } else if (!hasPrimaryCustomer && !existingAssociation.isPrimary) {
      await tx.orderCustomer.update({
        where: { id: existingAssociation.id },
        data: { isPrimary: true },
      })
    }

    return tx.order.update({
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
      },
    })
  })

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

  return result
}

/**
 * Cancel an unpaid order
 *
 * @param venueId Venue ID
 * @param orderId Order ID
 * @param reason Cancellation reason
 */
export async function cancelOrder(venueId: string, orderId: string, reason?: string, performedBy?: string): Promise<void> {
  logger.info(`📱 [ORDER.MOBILE] Cancelling order ${orderId} | venue=${venueId} | reason=${reason || 'none'}`)

  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
    select: { id: true, paymentStatus: true, status: true },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  if (order.paymentStatus === 'PAID') {
    throw new BadRequestError('Cannot cancel a paid order')
  }

  // A live/unknown terminal charge means money can still move: cancelling the order
  // now would let that charge land on a CANCELLED order (recorded & settled, but
  // excluded from reports). The POS must cancel or resolve the charge first.
  // CANCEL_REQUESTED does NOT block (see hasChargeBlockingOrderCancel).
  const { terminalPaymentService } = await import('../terminal-payment.service')
  if (await terminalPaymentService.hasChargeBlockingOrderCancel(venueId, orderId)) {
    throw new ConflictError(
      'Hay un cobro en curso en la terminal para esta orden. Cancela o espera el resultado del cobro antes de cancelar la orden.',
    )
  }

  await prisma.order.update({
    where: { id: orderId },
    data: {
      status: 'CANCELLED',
      specialRequests: reason ? `Cancelled: ${reason}` : order.status,
    },
  })

  logger.info(`✅ [ORDER.MOBILE] Order ${orderId} cancelled`)

  // TABLE_SERVICE — "Anular cuenta" on an open table: a cancelled check must
  // release its table (clearTable would refuse: the order is unpaid, not PAID).
  // No-op for orders not bound to a table. Mirrors Square: voiding the check
  // closes it and frees the table immediately.
  const boundTable = await prisma.table.findFirst({
    where: { venueId, currentOrderId: orderId },
    select: { id: true, number: true },
  })
  if (boundTable) {
    // Multi-cheque: si quedan otras cuentas abiertas en la mesa, re-apuntar
    // en vez de liberar.
    const sibling = await prisma.order.findFirst({
      where: { venueId, tableId: boundTable.id, id: { not: orderId }, status: { notIn: ['COMPLETED', 'CANCELLED', 'DELETED'] } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    })
    await prisma.table.update({
      where: { id: boundTable.id },
      data: sibling ? { status: 'OCCUPIED', currentOrderId: sibling.id } : { status: 'AVAILABLE', currentOrderId: null },
    })
    logger.info(
      sibling
        ? `✅ [ORDER.MOBILE] Table ${boundTable.number} repointed to sibling check after cancellation`
        : `✅ [ORDER.MOBILE] Table ${boundTable.number} released after order cancellation`,
    )
  }

  const { logAction } = await import('../dashboard/activity-log.service')
  void logAction({
    action: 'ORDER_CANCELLED',
    entity: 'Order',
    entityId: orderId,
    staffId: performedBy,
    venueId,
    data: { reason: reason ?? null },
  })

  // Emit Socket.IO event
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastToVenue(venueId, SocketEventType.ORDER_UPDATED, {
      orderId,
      status: 'CANCELLED',
    })
    if (boundTable) {
      broadcastingService.broadcastToVenue(venueId, SocketEventType.TABLE_STATUS_CHANGE, {
        tableId: boundTable.id,
        tableNumber: boundTable.number,
        status: 'AVAILABLE',
        orderId: null,
        orderNumber: null,
      })
    }
  }
}
