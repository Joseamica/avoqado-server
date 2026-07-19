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
import {
  buildItemDiscountRow,
  calculateDiscountPesos,
  validateDiscountActive,
  validateDiscountScopeForItem,
} from '../shared/discount.service'

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
    modifiers: Array<{
      id: string
      name: string
      price: number
    }>
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
      modifiers: item.modifiers || [],
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

  const validatedStaffId = await validateStaffVenue(input.staffId, venueId)

  // Validate items array
  if (!input.items || input.items.length === 0) {
    throw new BadRequestError('At least one item is required')
  }

  // Split items into product items (need DB lookup) and custom items (trust client name + unitPrice).
  const productInputs = input.items.filter(
    (item): item is CreateOrderItemInput & { productId: string } => typeof item.productId === 'string' && item.productId.length > 0,
  )
  const customInputs = input.items.filter(item => !item.productId)

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
  const discountIds = [...new Set(input.items.map(item => item.discountId).filter((id): id is string => !!id))]
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

  // Generate order number
  const orderNumber = `ORD-${Date.now()}`

  // Calculate totals and prepare items data.
  // NOTE: Prices are treated as tax-inclusive (Mexico: IVA is already in price).
  // taxAmount is stored as 0 on items and order. Tax is not added on top of the price.
  // Item/order totals stay gross; discount reductions live in `discountAmount`
  // (same convention as TPV's Cobrar V1 flow — see order.tpv.service.ts).
  let subtotal = 0
  let itemDiscountTotal = 0
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
    const weightKg = item.weightQuantity != null ? Number(item.weightQuantity) : null
    if (product.soldByWeight) {
      if (weightKg == null || !Number.isFinite(weightKg) || weightKg <= 0) {
        throw new BadRequestError(`El producto "${product.name}" se vende por peso; envía weightQuantity en kilogramos.`)
      }
      if (weightKg < 0.001 || weightKg > 99.999) {
        throw new BadRequestError(`El peso para "${product.name}" está fuera de rango (0.001–99.999 kg).`)
      }
      if (item.quantity !== 1) {
        throw new BadRequestError(`Las líneas por peso llevan cantidad 1 — cada pesada es una línea (producto "${product.name}").`)
      }
    } else if (weightKg != null) {
      throw new BadRequestError(`El producto "${product.name}" no se vende por peso; no envíes weightQuantity.`)
    }

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
    }
  })

  const itemsData = [...productItemsData, ...customItemsData]

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
  const amount = discount.type === 'PERCENTAGE' ? Math.round(((subtotal * value) / 100) * 100) / 100 : Math.min(value, subtotal)

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
      items: { select: { id: true } },
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
}

export interface CashPaymentResponse {
  paymentId: string
  orderId: string
  orderNumber: string
  amount: number
  tipAmount: number
  method: 'CASH'
  status: 'COMPLETED'
  changeAmount?: number // For display purposes (calculated on iOS)
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
    },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  if (order.paymentStatus === 'PAID') {
    throw new BadRequestError('Order is already paid')
  }

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

  // Create payment and update order in transaction
  const paymentResult = await prisma.$transaction(async tx => {
    // Create payment record
    const newPayment = await tx.payment.create({
      data: {
        venueId,
        orderId,
        amount: amountDecimal,
        tipAmount: tipDecimal,
        method: 'CASH',
        status: 'COMPLETED',
        type: 'REGULAR',
        splitType: 'FULLPAYMENT',
        source: 'APP',
        processedById: effectiveStaffId,
        shiftId: currentShift?.id,
        // Cash payments have no card data or merchant account
        merchantAccountId: null,
        feePercentage: 0,
        feeAmount: 0,
        netAmount: amountDecimal + tipDecimal,
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

    // Update order payment status.
    // Convention: order.total = subtotal - discountAmount + tipAmount (Mexico: tax is inclusive in subtotal).
    // Recompute total defensively in case the order was created before tip was known.
    // CUMULATIVE across payments (split-the-bill): sum every prior COMPLETED
    // payment on this order so N partial payments converge to PAID — mirrors
    // updateOrderTotalsForStandalonePayment in payment.tpv.service.ts. With a
    // single full payment previousPayments is 0 and behavior is unchanged.
    const previousPayments = await tx.payment.findMany({
      where: { orderId, status: 'COMPLETED', id: { not: newPayment.id } },
      select: { amount: true, tipAmount: true },
    })
    const previousPaid = previousPayments.reduce((sum, p) => sum + Number(p.amount) + Number(p.tipAmount), 0)
    const previousTips = previousPayments.reduce((sum, p) => sum + Number(p.tipAmount), 0)

    const orderSubtotal = Number(order.subtotal)
    const orderDiscount = Number(order.discountAmount || 0)
    // 🔴 MONEY (auditoría): sin esto, cualquier pago parcial en efectivo BORRA
    // el cobro por servicio del total y el restante deja de cobrarlo.
    const orderServiceCharge = Number(order.serviceChargeAmount || 0)
    const totalTip = previousTips + tipDecimal
    const newTotal = orderSubtotal - orderDiscount + orderServiceCharge + totalTip
    const totalPaidIncludingTip = previousPaid + amountDecimal + tipDecimal
    const remainingAfterPayment = newTotal - totalPaidIncludingTip
    const isFullyPaid = remainingAfterPayment <= 0.01 // float tolerance, same as TPV path

    await tx.order.update({
      where: { id: orderId },
      data: {
        paymentStatus: isFullyPaid ? 'PAID' : 'PARTIAL',
        status: isFullyPaid ? 'COMPLETED' : 'PENDING',
        remainingBalance: Math.max(0, remainingAfterPayment),
        tipAmount: totalTip,
        total: new Prisma.Decimal(newTotal),
        splitType: 'FULLPAYMENT',
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

    return { newPayment, isFullyPaid }
  })
  const { newPayment: payment, isFullyPaid: orderFullyPaid } = paymentResult

  logger.info(`✅ [ORDER.MOBILE] Cash payment recorded | paymentId=${payment.id} | order=${order.orderNumber}`)

  // Inventory deduction on full payment (platform rule: stock deducts ONLY when
  // fully paid). This path historically skipped deduction entirely — cash sales
  // from desktop/tablets never lowered stock. Reuses the never-throws helper
  // from the TPV free-cart path: payment success is NEVER at risk (errors are
  // logged, not thrown), and it only fires on the PENDING/PARTIAL → PAID
  // transition (re-calls are blocked above by the "already paid" guard).
  // Weighted lines (weightQuantity) deduct kilos; see spec venta-por-peso.
  if (orderFullyPaid) {
    void (async () => {
      try {
        const { deductTrackedInventoryForFreeCart } = await import('@/services/tpv/order.tpv.service')
        const paidOrder = await prisma.order.findUnique({
          where: { id: orderId },
          include: { items: { include: { modifiers: { include: { modifier: true } } } } },
        })
        if (paidOrder) {
          await deductTrackedInventoryForFreeCart(paidOrder, effectiveStaffId || input.staffId || '')
        }
        // Real-time auto-reorder, mirroring recordOrderPayment: if this sale
        // left an ingredient at/below its reorder point, create the PO now.
        // Self-gated (feature + PREMIUM tier + config.enabled) and non-blocking.
        const { runAutoReorderForVenue } = await import('@/services/dashboard/autoReorder.service')
        await runAutoReorderForVenue(venueId)
      } catch (err) {
        logger.error('[ORDER.MOBILE] Post-payment inventory deduction/auto-reorder failed (payment unaffected)', {
          orderId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })()
  }

  // Auto-generate digital receipt so the dashboard drawer and "Enviar recibo"
  // button have an accessKey immediately (mirrors TPV payment flow behavior).
  // Fire-and-forget — receipt failures must not break the payment response.
  generateAndStoreReceipt(venueId, payment.id).catch(err => {
    logger.error('[ORDER.MOBILE] Failed to auto-generate digital receipt', {
      paymentId: payment.id,
      error: err instanceof Error ? err.message : String(err),
    })
  })

  // REFERRAL HOOK: trigger referral qualification if this order has a pending referral
  // (idempotent: no-ops if no PENDING Referral matches this orderId)
  try {
    const { onOrderPaid } = await import('@/services/referrals/referralQualification.service')
    await onOrderPaid({ orderId, venueId })
  } catch (err) {
    console.error('[referral hook] onOrderPaid failed for order', orderId, err)
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
      method: 'CASH',
      status: 'completed',
    })

    broadcastingService.broadcastToVenue(venueId, SocketEventType.ORDER_UPDATED, {
      orderId,
      orderNumber: order.orderNumber,
      paymentStatus: 'PAID',
    })
  }

  return {
    paymentId: payment.id,
    orderId,
    orderNumber: order.orderNumber,
    amount,
    tipAmount: tip,
    method: 'CASH',
    status: 'COMPLETED',
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
