import prisma from '../../utils/prismaClient'
import { Order, Prisma } from '@prisma/client'
import { NotFoundError, BadRequestError, ConflictError, ValidationError } from '../../errors/AppError'
import logger from '../../config/logger'
import socketManager from '../../communication/sockets'
import { SocketEventType } from '../../communication/sockets/types'
import { serializedInventoryService } from '../serialized-inventory/serializedInventory.service'
import { simRegistrationService } from '../serialized-inventory/simRegistration.service'
import { moduleService, MODULE_CODES } from '../modules/module.service'
import {
  deductInventoryForProduct,
  getProductInventoryMethod,
  getProductInventoryStatus,
} from '../dashboard/productInventoryIntegration.service'
import type { OrderModifierForInventory } from '../dashboard/rawMaterial.service'
import { logAction } from '../dashboard/activity-log.service'
import {
  buildItemDiscountRow,
  calculateDiscountPesos,
  validateDiscountActive,
  validateDiscountScopeForItem,
} from '../shared/discount.service'
import { assertVenueSalesEnabled } from '../venueSalesGuard'

/**
 * Helper function to flatten OrderItemModifier structure for Android compatibility
 *
 * Backend Prisma returns nested structure:
 * { modifiers: [{ id: "oim_123", modifier: { id, name, price } }] }
 *
 * Android DTOs expect flat structure:
 * { modifiers: [{ id, name, price }] }
 *
 * @param order Order with nested modifiers structure
 * @returns Order with flattened modifiers
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
            price: om.modifier?.price || om.price,
            type: om.modifier?.type || om.type,
            required: om.modifier?.required || om.required,
            displayOrder: om.modifier?.displayOrder || om.displayOrder,
          })) || [],
      })) || [],
  }
}

/**
 * Get all open orders (orders) for a venue
 * @param orgId Organization ID (for future authorization)
 * @param venueId Venue ID
 * @param options Optional filtering options for pay-later orders
 * @returns Array of orders with payment status PENDING or PARTIAL
 */
export async function getOrders(
  venueId: string,
  _orgId?: string,
  options?: {
    includePayLater?: boolean // If true, include pay-later orders
    onlyPayLater?: boolean // If true, ONLY return pay-later orders
    includeKiosk?: boolean // If true, include KIOSK orders (default: exclude)
  },
): Promise<(Order & { tableName: string | null })[]> {
  const where: any = {
    venueId,
    paymentStatus: {
      in: ['PENDING', 'PARTIAL'], // Equivalent to legacy 'OPEN' status
    },
  }

  // 🥝 KIOSK filtering: Exclude abandoned KIOSK orders from regular TPV order list
  // KIOSK orders are self-service and if abandoned, should NOT clutter the TPV order list.
  // The kiosk mode retrieves its own order by ID (getOrder), not from this list.
  if (!options?.includeKiosk) {
    where.source = { not: 'KIOSK' }
  }

  // Pay-later filtering logic
  // Pay-later orders = orders with customer linkage (OrderCustomer relationship)
  if (options?.onlyPayLater) {
    // Only return pay-later orders (has OrderCustomer)
    where.orderCustomers = { some: {} }
  } else if (!options?.includePayLater) {
    // Default behavior: EXCLUDE pay-later orders (no OrderCustomer)
    where.orderCustomers = { none: {} }
  }
  // If includePayLater is true, no filter is added (returns all)

  const orders = await prisma.order.findMany({
    where,
    include: {
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
      payments: {
        include: {
          allocations: true,
        },
      },
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      servedBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      table: {
        select: {
          id: true,
          number: true,
        },
      },
      orderCustomers: {
        include: {
          customer: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              phone: true,
              email: true,
            },
          },
        },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  })

  // Add computed tableName for Android app + flatten modifiers
  return orders.map(order => ({
    ...flattenOrderModifiers(order),
    tableName: order.table ? `Mesa ${order.table.number}` : null,
  }))
}

/**
 * Get a specific order (order) by ID
 * @param orgId Organization ID (for future authorization)
 * @param venueId Venue ID
 * @param orderId Order ID (Order ID)
 * @returns Order with detailed payment information
 *
 * NOTE: Does NOT filter by paymentStatus (unlike getOrders list).
 * This allows fetching paid orders for receipt display after payment.
 */
export async function getOrder(
  venueId: string,
  orderId: string,
  _orgId?: string,
): Promise<Order & { amount_left: number; tableName: string | null; lastSplitType: string | null }> {
  const order = await prisma.order.findUnique({
    where: {
      id: orderId,
      venueId,
      // ✅ NO paymentStatus filter - allow fetching paid orders for receipt display
    },
    include: {
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
          paymentAllocations: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
      },
      payments: {
        include: {
          allocations: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
      },
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      servedBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      table: {
        select: {
          id: true,
          number: true,
        },
      },
    },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  // 🐛 DEBUG: Log raw Prisma response to see if modifiers are included
  logger.info(`🔍 [GET ORDER] Order ${orderId} - Items count: ${order.items.length}`)
  order.items.forEach((item, idx) => {
    logger.info(`   Item ${idx + 1}: ${item.product?.name || item.productName || 'DELETED'}`)
    logger.info(`      Modifiers count: ${item.modifiers?.length || 0}`)
    if (item.modifiers && item.modifiers.length > 0) {
      item.modifiers.forEach((om: any) => {
        logger.info(`         - OrderItemModifier ID: ${om.id}`)
        logger.info(`         - Modifier: ${om.modifier?.name || om.name || 'NULL'} (${om.modifier?.price || om.price || 'NULL'})`)
      })
    }
  })

  // Calculate amount left to pay
  const orderTotal = Number(order.total || 0)
  const totalPayments = order.payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0)
  const amount_left = orderTotal - totalPayments

  // Construct table name for display in Android app
  const tableName = order.table ? `Mesa ${order.table.number}` : null

  const flattenedOrder = flattenOrderModifiers(order)

  // 🐛 DEBUG: Log flattened response to verify flattening worked
  logger.info(`🔍 [GET ORDER] After flattening - Items count: ${flattenedOrder.items.length}`)
  flattenedOrder.items.forEach((item: any, idx: number) => {
    logger.info(`   Item ${idx + 1}: ${item.product?.name || item.productName || 'DELETED'}`)
    logger.info(`      Flattened modifiers count: ${item.modifiers?.length || 0}`)
    if (item.modifiers && item.modifiers.length > 0) {
      item.modifiers.forEach((mod: any) => {
        logger.info(`         - ${mod.name} (${mod.price})`)
      })
    }
  })

  // Compute lastSplitType from most recent payment or order's splitType
  // Used by Android to restrict incompatible split options (prevents EQUALPARTS → PERPRODUCT)
  const lastSplitType = order.payments?.[0]?.splitType || order.splitType || null

  // ✅ Compute paidItemIds - items that have at least one payment allocation
  // Used by Android SplitByProductScreen to show paid items as disabled
  const paidItemIds = order.items
    .filter((item: any) => item.paymentAllocations && item.paymentAllocations.length > 0)
    .map((item: any) => item.id)

  logger.info(`🔍 [GET ORDER] paidItemIds: ${paidItemIds.length > 0 ? paidItemIds.join(', ') : 'none'}`)

  return {
    ...flattenedOrder,
    amount_left,
    tableName, // 🆕 Add computed tableName for Android MenuScreen title
    lastSplitType, // 🆕 For split type restriction in Android UI
    paidItemIds, // 🆕 For SplitByProduct screen to show paid items as disabled
  }
}

interface CreateOrderInput {
  tableId?: string | null
  covers?: number
  waiterId?: string
  orderType?: 'DINE_IN' | 'TAKEOUT' | 'DELIVERY' | 'PICKUP'
  terminalId?: string | null // Terminal that created this order (for sales attribution)
  deviceSerialNumber?: string // Auto-resolve terminalId from serial if terminalId not provided
  source?: 'TPV' | 'KIOSK' | 'QR' | 'WEB' | 'APP' | 'PHONE' | 'POS' // Order source - KIOSK orders are excluded from pay-later lists
  externalId?: string | null // Idempotency key (client order ID)
}

/**
 * Create a new order (for quick orders, counter service, delivery, etc.)
 * Generates CUID orderId and sequential orderNumber.
 * @param venueId Venue ID (tenant isolation)
 * @param input Order creation parameters
 * @returns Newly created order
 */
export async function createOrder(venueId: string, input: CreateOrderInput): Promise<Order & { tableName: string | null }> {
  logger.info(
    `🆕 [ORDER SERVICE] Creating new order | venue=${venueId} | type=${input.orderType || 'DINE_IN'} | table=${input.tableId || 'none'} | source=${input.source || 'TPV'}`,
  )

  if (input.externalId) {
    const existingOrder = await prisma.order.findUnique({
      where: {
        venueId_externalId: {
          venueId,
          externalId: input.externalId,
        },
      },
      include: {
        items: {
          include: {
            product: true,
            modifiers: {
              include: {
                modifier: true,
              },
            },
          },
        },
        payments: true,
        table: {
          select: {
            id: true,
            number: true,
          },
        },
        createdBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
        servedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    })

    if (existingOrder) {
      logger.warn(`🔄 [ORDER SERVICE] Duplicate createOrder detected (externalId=${input.externalId}) - returning existing order`)
      const tableName = existingOrder.table ? `Mesa ${existingOrder.table.number}` : null
      return {
        ...flattenOrderModifiers(existingOrder),
        tableName,
      }
    }
  }

  await assertVenueSalesEnabled(venueId)

  // Validate staff if provided
  if (input.waiterId) {
    const staff = await prisma.staff.findUnique({
      where: { id: input.waiterId },
    })
    if (!staff) {
      throw new NotFoundError('Staff member not found')
    }
  }

  // Generate order number (sequential timestamp-based)
  const orderNumber = `ORD-${Date.now()}`

  // Resolve terminalId: use explicit terminalId, or auto-resolve from deviceSerialNumber (JWT)
  let resolvedTerminalId = input.terminalId || null
  if (!resolvedTerminalId && input.deviceSerialNumber) {
    const terminal = await prisma.terminal.findFirst({
      where: { serialNumber: input.deviceSerialNumber, venueId },
      select: { id: true },
    })
    if (terminal) {
      resolvedTerminalId = terminal.id
      logger.debug(`✅ [ORDER] Auto-resolved deviceSerialNumber ${input.deviceSerialNumber} → terminalId ${terminal.id}`)
    }
  }

  // Create order
  const order = await prisma.order.create({
    data: {
      venueId,
      tableId: input.tableId || null,
      covers: input.covers || 1,
      orderNumber,
      servedById: input.waiterId || null,
      createdById: input.waiterId || null,
      terminalId: resolvedTerminalId, // Track which terminal created this order
      status: 'PENDING',
      paymentStatus: 'PENDING',
      kitchenStatus: 'PENDING',
      type: input.orderType || 'DINE_IN',
      source: input.source || 'TPV', // KIOSK orders are excluded from pay-later/open orders lists
      externalId: input.externalId || null,
      subtotal: 0,
      discountAmount: 0,
      taxAmount: 0,
      total: 0,
      version: 1,
    },
    include: {
      items: true,
      payments: true,
      table: {
        select: {
          id: true,
          number: true,
        },
      },
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      servedBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  })

  logger.info(`✅ [ORDER SERVICE] Order created | id=${order.id} | number=${order.orderNumber} | type=${order.type}`)

  // Emit Socket.IO event for real-time order creation notification
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastToVenue(venueId, SocketEventType.ORDER_CREATED, {
      orderId: order.id,
      orderNumber: order.orderNumber,
      orderType: order.type,
      tableId: order.tableId,
      covers: order.covers,
    })
  }

  // Construct table name for display in Android app
  const tableName = order.table ? `Mesa ${order.table.number}` : null

  return {
    ...flattenOrderModifiers(order),
    tableName,
  }
}

interface AddOrderItemInput {
  /** Catalog product — omit for a custom-amount line (customName + customUnitPriceCents). */
  productId?: string | null
  quantity: number
  notes?: string | null
  modifierIds?: string[] // Array of modifier IDs to add to the order item
  externalId?: string | null
  /** TABLE_SERVICE course/tiempo ("Aperitivos"...). Null = prepare immediately. */
  course?: string | null
  /** Custom-amount line (no catalog product): label + unit price in cents. */
  customName?: string | null
  customUnitPriceCents?: number | null
  /** Venta por peso: kilos pesados (0.001–99.999). REQUIRED when the product is
   *  soldByWeight (quantity must be 1), REJECTED otherwise. Server computes the
   *  total; weighted lines NEVER merge (D9 in the spec). */
  weightQuantity?: number | null
  /** TABLE_SERVICE: the line lands ALREADY comped (Square's cortesía picked in
   *  the product detail before sending). total=0, discountAmount=list price. */
  isCortesia?: boolean | null
  cortesiaReason?: string | null
  /** TABLE_SERVICE: asiento/comensal de la línea (Square's seats). */
  seat?: number | null
}

interface NormalizedAddOrderItemInput extends AddOrderItemInput {
  _count: number
}

function normalizeNotes(notes?: string | null): string | null {
  if (!notes) return null
  const trimmed = notes.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizeExternalId(externalId?: string | null): string | null {
  if (!externalId) return null
  const trimmed = externalId.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizeModifierIds(modifierIds?: string[]): string[] {
  return (modifierIds || []).filter(Boolean).sort()
}

function buildAddItemKey(productId: string, modifierIds: string[], notes: string | null, externalId: string | null): string {
  const notesKey = notes ?? ''
  const modifiersKey = modifierIds.join('|')
  const externalKey = externalId ?? ''
  return `${productId}|${notesKey}|${modifiersKey}|${externalKey}`
}

// Exported for unit tests (D9: weighted lines must never merge).
export function normalizeAddItems(items: AddOrderItemInput[]): NormalizedAddOrderItemInput[] {
  const map = new Map<string, NormalizedAddOrderItemInput>()

  for (const [index, item] of items.entries()) {
    const normalizedNotes = normalizeNotes(item.notes)
    const normalizedModifiers = normalizeModifierIds(item.modifierIds)
    const normalizedExternalId = normalizeExternalId(item.externalId)
    const normalizedCourse = item.course?.trim() || null
    // Custom-amount lines never merge with catalog lines (distinct key space).
    const keyBase = item.productId
      ? buildAddItemKey(item.productId, normalizedModifiers, normalizedNotes, normalizedExternalId)
      : `custom:${item.customName ?? ''}:${item.customUnitPriceCents ?? 0}:${normalizedNotes ?? ''}`
    let key = keyBase + `|c:${normalizedCourse ?? ''}`
    // D9 (venta por peso): each weighing is its own line — weighted lines get a
    // per-index key so two weighings of the same product NEVER merge here.
    if (item.weightQuantity != null) key += `|w#${index}`
    // Cortesía: comped lines never merge (a merge would swallow the $0 line
    // into a paid one — money bug), so they also get a per-index key.
    if (item.isCortesia === true) key += `|comp#${index}`
    // Asientos: lines for different seats never merge.
    key += `|s:${item.seat ?? ''}`

    const existing = map.get(key)
    if (existing) {
      existing.quantity += item.quantity
      existing._count += 1
    } else {
      map.set(key, {
        productId: item.productId,
        quantity: item.quantity,
        notes: normalizedNotes,
        modifierIds: normalizedModifiers,
        externalId: normalizedExternalId,
        course: normalizedCourse,
        customName: item.customName ?? null,
        customUnitPriceCents: item.customUnitPriceCents ?? null,
        weightQuantity: item.weightQuantity ?? null,
        isCortesia: item.isCortesia ?? null,
        cortesiaReason: item.cortesiaReason ?? null,
        seat: item.seat ?? null,
        _count: 1,
      })
    }
  }

  return Array.from(map.values())
}

// All monetary fields are pesos (decimals), matching the rest of the /tpv/* API.
// E.g. $25.45 is 25.45, NOT 2545 cents. The service rounds intermediate math
// to 2 decimal places and validates client-sent totals with ±$0.01 tolerance.
type TpvCreateOrderWithItemsInput = {
  items: Array<{
    productId?: string | null
    name?: string | null
    quantity: number
    unitPrice?: number | null // pesos for custom line items
    modifierIds?: string[]
    notes?: string | null
    isCortesia?: boolean
    cortesiaReason?: string | null
    itemDiscountId?: string | null
  }>
  staffId: string
  orderType?: 'DINE_IN' | 'TAKEOUT' | 'DELIVERY' | 'PICKUP'
  source?: 'TPV' | 'KIOSK' | 'QR' | 'WEB' | 'APP' | 'PHONE' | 'POS'
  tableId?: string | null
  customerId?: string | null
  discount?: number // pesos
  orderDiscountId?: string | null
  taxAmount: number // pesos (must be 0 in V1)
  tip?: number // pesos (must be 0 in V1)
  subtotal: number // pesos (gross)
  total: number // pesos (net = subtotal - discountAmount)
  note?: string | null
  terminalId?: string | null
  deviceSerialNumber?: string | null
}

type PreparedCheckoutLine = {
  input: TpvCreateOrderWithItemsInput['items'][number]
  product: any | null
  modifierRows: any[]
  modifierGrossPesos: number
  lineGrossPesos: number
  lineDiscountPesos: number
  appliedDiscount: any | null
}

const PESOS_TOLERANCE = 0.01

function roundPesos(value: number): number {
  return Math.round(value * 100) / 100
}

function decimalFromPesos(value: number): Prisma.Decimal {
  return new Prisma.Decimal(roundPesos(value))
}

function assertClosePesos(label: string, actual: number, expected: number): void {
  if (Math.abs(actual - expected) > PESOS_TOLERANCE) {
    throw new BadRequestError(`${label} mismatch. Expected ${expected.toFixed(2)} pesos, got ${actual.toFixed(2)} pesos`)
  }
}

async function fetchOrderForTpvResponse(orderId: string) {
  return prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: {
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
          paymentAllocations: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
      },
      payments: {
        include: {
          allocations: true,
        },
      },
      table: {
        select: {
          id: true,
          number: true,
        },
      },
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      servedBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      orderCustomers: {
        include: {
          customer: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              phone: true,
              email: true,
            },
          },
        },
      },
      orderDiscounts: true,
    },
  })
}

/**
 * Free-cart inventory deduction. NEVER throws — the Order+Payment+Items
 * transaction has already committed by the time this runs (the inventory
 * helpers use the global prisma client and aren't safe to call inside a
 * Prisma $transaction). If deduction fails for any tracked product, we
 * write an `OrderAction{actionType:'INVENTORY_DEDUCTION_FAILED'}` row so
 * the failure is captured for reconciliation, but the order still ships
 * as COMPLETED + PAID. This is preferable to silent drift OR to a
 * customer-visible error after the cart already closed.
 */
// Exported: also reused by the mobile cash path (payCashOrder in
// order.mobile.service.ts), which historically never deducted inventory at all —
// same never-throws contract there (payment success is never at risk).
export async function deductTrackedInventoryForFreeCart(order: any, staffId: string): Promise<void> {
  const deductionErrors: Array<{ productId: string; productName: string; error: string }> = []

  for (const item of order.items || []) {
    if (!item.productId) {
      logger.info('⏭️ [WITH ITEMS] Skipping inventory deduction for custom line item', {
        orderId: order.id,
        orderItemId: item.id,
        productName: item.productName,
        reason: 'CUSTOM_LINE_ITEM',
      })
      continue
    }

    const inventoryMethod = await getProductInventoryMethod(item.productId)
    if (!inventoryMethod) {
      logger.info('⏭️ [WITH ITEMS] Skipping inventory deduction for untracked product', {
        orderId: order.id,
        orderItemId: item.id,
        productId: item.productId,
        productName: item.product?.name || item.productName,
        reason: 'UNTRACKED_PRODUCT',
      })
      continue
    }

    try {
      const orderModifiers: OrderModifierForInventory[] =
        item.modifiers
          ?.filter((m: any) => m.modifier)
          .map((m: any) => ({
            quantity: m.quantity,
            modifier: {
              id: m.modifier.id,
              name: m.modifier.name,
              groupId: m.modifier.groupId,
              rawMaterialId: m.modifier.rawMaterialId,
              quantityPerUnit: m.modifier.quantityPerUnit,
              unit: m.modifier.unit,
              inventoryMode: m.modifier.inventoryMode,
            },
          })) || []

      // Weighted lines deduct the weighed kilos, not the (always-1) quantity.
      const effectiveQuantity = item.weightQuantity != null ? Number(item.weightQuantity) : item.quantity
      await deductInventoryForProduct(order.venueId, item.productId, effectiveQuantity, order.id, staffId, orderModifiers)
    } catch (error: any) {
      logger.error('❌ [WITH ITEMS] Failed to deduct inventory for free cart item', {
        orderId: order.id,
        orderItemId: item.id,
        productId: item.productId,
        error: error.message,
      })
      deductionErrors.push({
        productId: item.productId,
        productName: item.product?.name || item.productName || 'Unknown',
        error: error.message,
      })
    }
  }

  if (deductionErrors.length > 0) {
    // Order already shipped (COMPLETED + PAID) before we ran. Capture the
    // drift in a structured log so Crashlytics/Sentry surface it for ops
    // reconciliation. We do NOT throw — the visible state is consistent
    // (order is closed, customer is happy); the worst case is dashboard
    // stock numbers being stale until ops reconciles. Throwing here would
    // surface a misleading client error while the order is already paid.
    logger.error('❌ [WITH ITEMS] FREE_CART_INVENTORY_DRIFT', {
      orderId: order.id,
      venueId: order.venueId,
      staffId,
      failures: deductionErrors,
      source: 'TPV_COBRAR_WITH_ITEMS',
      severity: 'reconcile_required',
    })
  }
}

export async function createOrderWithItems(
  venueId: string,
  input: TpvCreateOrderWithItemsInput,
): Promise<Order & { tableName: string | null }> {
  logger.info(`🧾 [WITH ITEMS] Creating TPV order with ${input.items.length} item(s) | venue=${venueId}`)

  await assertVenueSalesEnabled(venueId)

  if (Math.abs(input.taxAmount) > PESOS_TOLERANCE) {
    throw new BadRequestError('taxAmount must be 0 in V1 of the new TPV Cobrar flow')
  }

  if (Math.abs(input.tip || 0) > PESOS_TOLERANCE) {
    throw new BadRequestError('tip must be added through the payment flow, not the create-order-with-items endpoint')
  }

  const staffVenue = await prisma.staffVenue.findUnique({
    where: {
      staffId_venueId: {
        staffId: input.staffId,
        venueId,
      },
    },
    include: {
      staff: true,
    },
  })
  if (!staffVenue?.staff || !staffVenue.active || !staffVenue.staff.active) {
    throw new NotFoundError('Active staff member not found for this venue')
  }

  const productIds = [...new Set(input.items.map(item => item.productId).filter((id): id is string => !!id))]
  const products = productIds.length
    ? await prisma.product.findMany({
        where: {
          id: { in: productIds },
          venueId,
          deletedAt: null,
        },
        include: {
          category: {
            select: {
              name: true,
            },
          },
        },
      })
    : []

  if (products.length !== productIds.length) {
    const foundIds = products.map(product => product.id)
    const missingIds = productIds.filter(id => !foundIds.includes(id))
    throw new BadRequestError(`Products not found or do not belong to this venue: ${missingIds.join(', ')}`)
  }

  const allModifierIds = [...new Set(input.items.flatMap(item => item.modifierIds || []))]
  const modifiers = allModifierIds.length
    ? await prisma.modifier.findMany({
        where: {
          id: { in: allModifierIds },
          group: {
            venueId,
          },
        },
      })
    : []

  if (modifiers.length !== allModifierIds.length) {
    const foundIds = modifiers.map(modifier => modifier.id)
    const missingIds = allModifierIds.filter(id => !foundIds.includes(id))
    throw new BadRequestError(`Modifiers not found or do not belong to this venue: ${missingIds.join(', ')}`)
  }

  const discountIds = [
    ...new Set([input.orderDiscountId || null, ...input.items.map(item => item.itemDiscountId || null)].filter((id): id is string => !!id)),
  ]
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
    throw new BadRequestError(`Discounts not found or do not belong to this venue: ${missingIds.join(', ')}`)
  }

  discounts.forEach(validateDiscountActive)

  const preparedLines: PreparedCheckoutLine[] = input.items.map(item => {
    if (item.isCortesia && item.itemDiscountId) {
      throw new BadRequestError('An item cannot be both cortesía and discounted')
    }

    const product = item.productId ? products.find(p => p.id === item.productId)! : null
    // Venta por peso: this PAX/TPV checkout flow has no weight capture yet
    // (the client asserts its own totals via assertClosePesos), so weighted
    // products are rejected loudly instead of silently charging price × 1.
    if (product?.soldByWeight) {
      throw new BadRequestError(`El producto "${product.name}" se vende por peso; véndelo desde un punto de venta con captura de peso.`)
    }
    const itemModifiers = item.modifierIds || []
    const modifierRows = itemModifiers.map(modifierId => modifiers.find(m => m.id === modifierId)!)
    const modifierGrossPesos = itemModifiers.reduce((sum, modifierId) => {
      const modifier = modifiers.find(m => m.id === modifierId)!
      return sum + Number(modifier.price)
    }, 0)

    const unitPricePesos = product ? Number(product.price) : Number(item.unitPrice || 0)
    const lineGrossPesos = roundPesos((unitPricePesos + modifierGrossPesos) * item.quantity)
    const appliedDiscount = item.itemDiscountId ? discounts.find(discount => discount.id === item.itemDiscountId)! : null
    if (appliedDiscount) {
      validateDiscountScopeForItem(appliedDiscount, { productId: product?.id ?? null, categoryId: product?.categoryId ?? null })
    }
    const lineDiscountPesos = item.isCortesia
      ? lineGrossPesos
      : appliedDiscount
        ? calculateDiscountPesos(appliedDiscount, lineGrossPesos)
        : 0

    return {
      input: item,
      product,
      modifierRows,
      modifierGrossPesos,
      lineGrossPesos,
      lineDiscountPesos,
      appliedDiscount,
    }
  })

  const grossSubtotalPesos = roundPesos(preparedLines.reduce((sum, line) => sum + line.lineGrossPesos, 0))
  const itemDiscountPesos = roundPesos(preparedLines.reduce((sum, line) => sum + line.lineDiscountPesos, 0))
  const orderDiscount = input.orderDiscountId ? discounts.find(discount => discount.id === input.orderDiscountId)! : null
  const orderDiscountPesos = orderDiscount
    ? calculateDiscountPesos(orderDiscount, grossSubtotalPesos - itemDiscountPesos)
    : roundPesos(input.discount || 0)
  const discountAmountPesos = roundPesos(itemDiscountPesos + orderDiscountPesos)
  const totalPesos = roundPesos(grossSubtotalPesos - discountAmountPesos)

  assertClosePesos('subtotal', input.subtotal, grossSubtotalPesos)
  assertClosePesos('discount', input.discount || 0, orderDiscountPesos)
  assertClosePesos('total', input.total, totalPesos)

  if (totalPesos < 0) {
    throw new BadRequestError('Order total cannot be negative')
  }

  let resolvedTerminalId = input.terminalId || null
  if (!resolvedTerminalId && input.deviceSerialNumber) {
    const terminal = await prisma.terminal.findFirst({
      where: { serialNumber: input.deviceSerialNumber, venueId },
      select: { id: true },
    })
    resolvedTerminalId = terminal?.id || null
  }

  const orderNumber = `ORD-${Date.now()}`
  const createdOrder = await prisma.$transaction(async tx => {
    const currentShift = await tx.shift.findFirst({
      where: {
        venueId,
        staffId: input.staffId,
        status: 'OPEN',
        endTime: null,
      },
      orderBy: {
        startTime: 'desc',
      },
    })

    // New Cobrar V1 keeps total/subtotal gross-net semantics explicit:
    // OrderItem.total and Order.subtotal are gross, reductions live in discountAmount.
    const isFreeCart = totalPesos === 0
    const order = await tx.order.create({
      data: {
        venueId,
        tableId: input.tableId || null,
        customerId: input.customerId || null,
        covers: 1,
        orderNumber,
        servedById: input.staffId,
        createdById: input.staffId,
        terminalId: resolvedTerminalId,
        status: isFreeCart ? 'COMPLETED' : 'PENDING',
        paymentStatus: isFreeCart ? 'PAID' : 'PENDING',
        kitchenStatus: 'PENDING',
        type: input.orderType || 'TAKEOUT',
        source: input.source || 'TPV',
        subtotal: decimalFromPesos(grossSubtotalPesos),
        discountAmount: decimalFromPesos(discountAmountPesos),
        taxAmount: 0,
        tipAmount: 0,
        total: decimalFromPesos(totalPesos),
        paidAmount: 0,
        remainingBalance: decimalFromPesos(totalPesos),
        completedAt: isFreeCart ? new Date() : null,
        specialRequests: normalizeNotes(input.note),
        version: 1,
      },
    })

    const createdItems: Array<{ id: string; line: PreparedCheckoutLine }> = []

    for (const line of preparedLines) {
      const item = await tx.orderItem.create({
        data: {
          orderId: order.id,
          productId: line.product?.id || null,
          productName: line.product?.name || line.input.name || 'Otro importe',
          productSku: line.product?.sku || null,
          categoryName: line.product?.category?.name || null,
          quantity: line.input.quantity,
          unitPrice: line.product ? line.product.price : decimalFromPesos(Number(line.input.unitPrice || 0)),
          discountAmount: decimalFromPesos(line.lineDiscountPesos),
          taxAmount: 0,
          total: decimalFromPesos(line.lineGrossPesos),
          isCortesia: !!line.input.isCortesia,
          cortesiaReason: line.input.isCortesia ? normalizeNotes(line.input.cortesiaReason) : null,
          appliedDiscountId: line.appliedDiscount?.id || null,
          notes: normalizeNotes(line.input.notes),
          modifiers: {
            create: line.modifierRows.map(modifier => ({
              modifierId: modifier.id,
              name: modifier.name,
              quantity: 1,
              price: modifier.price,
            })),
          },
        },
      })

      createdItems.push({ id: item.id, line })
    }

    const cortesiaItems = createdItems.filter(item => item.line.input.isCortesia)
    if (cortesiaItems.length > 0) {
      const cortesiaAmountPesos = roundPesos(cortesiaItems.reduce((sum, item) => sum + item.line.lineGrossPesos, 0))
      await tx.orderDiscount.create({
        data: {
          orderId: order.id,
          type: 'COMP',
          name: 'Cortesía',
          value: new Prisma.Decimal(100),
          amount: decimalFromPesos(cortesiaAmountPesos),
          taxReduction: 0,
          isComp: true,
          isManual: true,
          compReason:
            cortesiaItems
              .map(item => item.line.input.cortesiaReason)
              .filter(Boolean)
              .join('; ') || 'Cortesía',
          appliedById: staffVenue.id,
          appliedToItemIds: cortesiaItems.map(item => item.id),
        },
      })
    }

    for (const item of createdItems.filter(item => item.line.appliedDiscount)) {
      await tx.orderDiscount.create({
        data: buildItemDiscountRow({
          orderId: order.id,
          itemId: item.id,
          discount: item.line.appliedDiscount!,
          discountAmountPesos: item.line.lineDiscountPesos,
          appliedById: staffVenue.id,
        }),
      })
    }

    if (orderDiscount && orderDiscountPesos > 0) {
      await tx.orderDiscount.create({
        data: {
          orderId: order.id,
          discountId: orderDiscount.id,
          type: orderDiscount.type,
          name: orderDiscount.name,
          value: orderDiscount.value,
          amount: decimalFromPesos(orderDiscountPesos),
          taxReduction: 0,
          isComp: orderDiscount.type === 'COMP',
          isManual: true,
          compReason: orderDiscount.type === 'COMP' ? orderDiscount.compReason || orderDiscount.name : null,
          appliedById: staffVenue.id,
          appliedToItemIds: createdItems.filter(item => !item.line.input.isCortesia).map(item => item.id),
        },
      })
    }

    const usedDiscountIds = [...new Set(createdItems.map(item => item.line.appliedDiscount?.id).filter(Boolean) as string[])]
    if (orderDiscount?.id) usedDiscountIds.push(orderDiscount.id)
    if (usedDiscountIds.length > 0) {
      await tx.discount.updateMany({
        where: { id: { in: [...new Set(usedDiscountIds)] } },
        data: { currentUses: { increment: 1 } },
      })
    }

    for (const item of cortesiaItems) {
      await tx.orderAction.create({
        data: {
          orderId: order.id,
          actionType: 'COMP',
          performedById: input.staffId,
          reason: item.line.input.cortesiaReason || 'Cortesía',
          metadata: {
            orderItemId: item.id,
            productId: item.line.product?.id || null,
            productName: item.line.product?.name || item.line.input.name || 'Otro importe',
            lineSubtotalGivenAway: roundPesos(item.line.lineGrossPesos),
            cortesiaReason: item.line.input.cortesiaReason,
          },
        },
      })
    }

    if (input.customerId) {
      await tx.orderCustomer.create({
        data: {
          orderId: order.id,
          customerId: input.customerId,
          isPrimary: true,
        },
      })
    }

    if (isFreeCart) {
      // A $0 cortesía cart still needs a Payment row so financial views can
      // distinguish a completed free cart from an abandoned pending order.
      const payment = await tx.payment.create({
        data: {
          venueId,
          orderId: order.id,
          shiftId: currentShift?.id,
          processedById: input.staffId,
          amount: 0,
          tipAmount: 0,
          method: 'OTHER',
          source: 'TPV',
          status: 'COMPLETED',
          splitType: 'FULLPAYMENT',
          type: 'REGULAR',
          processor: 'AVOQADO',
          processorData: {
            type: 'FREE_CART',
            reason: 'total_zero_cortesia_or_discount',
          },
          feePercentage: 0,
          feeAmount: 0,
          netAmount: 0,
          posRawData: {
            source: 'TPV_COBRAR_WITH_ITEMS',
          },
        },
      })

      await tx.paymentAllocation.create({
        data: {
          paymentId: payment.id,
          orderId: order.id,
          amount: 0,
        },
      })

      if (currentShift) {
        await tx.shift.update({
          where: { id: currentShift.id },
          data: {
            totalOrders: { increment: 1 },
          },
        })
      }
    }

    return order
  })

  const fullOrder = await fetchOrderForTpvResponse(createdOrder.id)

  if (totalPesos === 0) {
    await deductTrackedInventoryForFreeCart(fullOrder, input.staffId)
  }

  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastToVenue(venueId, SocketEventType.ORDER_CREATED, {
      orderId: fullOrder.id,
      orderNumber: fullOrder.orderNumber,
      orderType: fullOrder.type,
      tableId: fullOrder.tableId,
      subtotal: Number(fullOrder.subtotal),
      discountAmount: Number(fullOrder.discountAmount),
      total: Number(fullOrder.total),
    })
  }

  const tableName = fullOrder.table ? `Mesa ${fullOrder.table.number}` : null
  return {
    ...flattenOrderModifiers(fullOrder),
    tableName,
  }
}

/**
 * Add items to an existing order with optimistic concurrency control
 * Uses version field to prevent concurrent updates (lost update problem)
 * @param venueId Venue ID
 * @param orderId Order ID
 * @param items Array of items to add
 * @param expectedVersion Expected version number for optimistic locking
 * @returns Updated order with new items
 */
export async function addItemsToOrder(
  venueId: string,
  orderId: string,
  items: AddOrderItemInput[],
  expectedVersion: number,
  /**
   * 🔴 MONEY — semántica cuando la línea ya existe en la orden:
   * - false (TPV register): el cliente re-manda el CARRITO COMPLETO, así que
   *   una línea igual se FUSIONA reemplazando la cantidad (estado absoluto —
   *   comportamiento histórico intacto).
   * - true (mesas /mobile): el request es UNA RONDA nueva (delta). Modelo
   *   Square verificado contra el POS real: cada Enviar crea SUS PROPIAS
   *   filas — nunca se fusiona con lo ya enviado — y todas comparten un
   *   sentToKitchenAt para que el panel las agrupe como "tiempo + hora de
   *   envío" repetible. Sin esto, pedir una segunda Clásica se interpretaba
   *   como "que quede 1": la cocina la preparaba y la cuenta no la cobraba
   *   (cazado en smoke de hardware 2026-07-19).
   */
  asNewRound: boolean = false,
): Promise<Order & { tableName: string | null }> {
  logger.info(`📝 [ORDER SERVICE] Adding ${items.length} items to order ${orderId} (expected version: ${expectedVersion})`)

  // Una ronda = un timestamp de envío compartido por todas sus filas (los
  // create corren en loop y sus createdAt difieren por ms — agrupar por
  // createdAt partiría la ronda).
  const roundSentAt = asNewRound ? new Date() : null

  const normalizedItems = normalizeAddItems(items)
  if (normalizedItems.length !== items.length) {
    logger.warn(
      `⚠️ [ADD ITEMS] Normalized ${items.length} items → ${normalizedItems.length} unique (duplicates merged by product+modifiers+notes)`,
    )
  }

  // Fetch order with version check
  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
    include: {
      items: {
        include: {
          product: true,
        },
      },
    },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  // Optimistic concurrency check
  // ✅ P1 FIX: Use 409 Conflict instead of 400 Bad Request for version mismatch
  // This allows the Android client to detect conflicts and refresh automatically
  if (order.version !== expectedVersion) {
    logger.warn(
      `⚠️ [ORDER SERVICE] Version mismatch! Expected: ${expectedVersion}, Got: ${order.version}. Order was modified by another request.`,
    )
    throw new ConflictError(
      `Order was modified by another request. Please refresh and try again. (Expected version: ${expectedVersion}, Current: ${order.version})`,
    )
  }

  // Validate order is not paid
  if (order.paymentStatus === 'PAID') {
    throw new BadRequestError('Cannot add items to a paid order')
  }

  // Fetch products and validate
  // ✅ FIX: Use Set to deduplicate productIds (same product can be added multiple times)
  const uniqueProductIds = [...new Set(items.map(item => item.productId).filter((id): id is string => !!id))]
  // Custom-amount lines need a label and a non-negative price.
  for (const item of items) {
    if (!item.productId && (!item.customName?.trim() || item.customUnitPriceCents == null || item.customUnitPriceCents < 0)) {
      throw new BadRequestError('Custom line requires customName and customUnitPriceCents >= 0')
    }
  }
  const products = await prisma.product.findMany({
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

  if (products.length !== uniqueProductIds.length) {
    const foundIds = products.map(p => p.id)
    const missingIds = uniqueProductIds.filter(id => !foundIds.includes(id))
    throw new BadRequestError(`Products not found or do not belong to this venue: ${missingIds.join(', ')}`)
  }

  // 🔴 Backstop de inventario para RONDAS: los tiles del cliente ya bloquean
  // agotados, pero una app vieja (o un request directo) puede mandarlos igual.
  // Solo productos RASTREADOS sin stock/porciones se rechazan — sin seguimiento
  // nunca se bloquea (el inventario es opcional por producto). Corre ANTES de
  // crear cualquier fila para no dejar rondas parciales, y falla ABIERTO si el
  // status no se puede calcular (un error de inventario no debe tirar servicio).
  if (asNewRound) {
    for (const product of products) {
      const status = await getProductInventoryStatus(venueId, product.id).catch(() => null)
      if (status?.inventoryMethod && !status.available) {
        throw new BadRequestError(`"${product.name}" está agotado`)
      }
    }
  }

  // Fetch all modifiers if any items have modifiers
  const allModifierIds = normalizedItems.flatMap(item => item.modifierIds || [])
  logger.info(`🔍 [ADD ITEMS] Modifier IDs requested: ${JSON.stringify(allModifierIds)}`)

  // ✅ P1 FIX: Add venueId filter through group relation to prevent cross-tenant access (security)
  // Modifier doesn't have direct venueId; it's accessed via ModifierGroup
  const modifiers =
    allModifierIds.length > 0
      ? await prisma.modifier.findMany({
          where: {
            id: { in: allModifierIds },
            group: {
              venueId, // Security: Only fetch modifiers that belong to this venue's groups
            },
          },
        })
      : []

  logger.info(`✅ [ADD ITEMS] Modifiers fetched from DB: ${modifiers.length} modifiers`)
  modifiers.forEach(m => logger.info(`  - ${m.name} (${m.id}): $${m.price}`))

  // ⭐ P0 FIX: UPSERT items - update existing items or create new ones
  // This fixes the bug where quantity updates created duplicate items
  // Previously, when TPV synced a quantity change, it called addItemsToOrder
  // which always created NEW items. Now we check for existing items first.
  const newOrderItems = await Promise.all(
    normalizedItems.map(async item => {
      // Custom-amount line: create directly (no catalog product, no modifiers).
      if (!item.productId) {
        const unitPrice = new Prisma.Decimal((item.customUnitPriceCents ?? 0) / 100)
        const customTotal = unitPrice.mul(item.quantity)
        const customComped = item.isCortesia === true
        const customItem = await prisma.orderItem.create({
          data: {
            orderId: order.id,
            productId: null,
            productName: item.customName!.trim(),
            quantity: item.quantity,
            unitPrice,
            discountAmount: customComped ? customTotal : 0,
            taxAmount: 0,
            total: customComped ? 0 : customTotal,
            isCortesia: customComped,
            cortesiaReason: customComped ? item.cortesiaReason?.trim() || null : null,
            notes: normalizeNotes(item.notes),
            course: item.course ?? null,
            seat: item.seat ?? null,
          },
          include: {
            product: {
              select: {
                id: true,
                name: true,
              },
            },
            modifiers: {
              include: {
                modifier: true,
              },
            },
          },
        })
        logger.info(`✅ [ADD ITEMS] CREATED custom line: ${customItem.productName} | $${customTotal}`)
        return customItem
      }

      const product = products.find(p => p.id === item.productId)!
      const normalizedNotes = normalizeNotes(item.notes)

      // Calculate modifier total
      const itemModifiers = item.modifierIds || []
      const modifierTotal = itemModifiers.reduce((sum, modifierId) => {
        const modifier = modifiers.find(m => m.id === modifierId)
        return sum + (modifier ? Number(modifier.price) : 0)
      }, 0)

      logger.info(
        `💰 [ADD ITEMS] Product: ${product.name} | Base: $${product.price} | Modifiers: $${modifierTotal} | Total per unit: $${Number(product.price) + modifierTotal}`,
      )

      // ─── Venta por peso (soldByWeight) — spec 2026-07-18-venta-por-peso ────
      // Weighted lines carry weightQuantity (kg) and quantity=1; the SERVER
      // computes base = round(price/kg × weightKg, 2). Weight on a non-weighted
      // product, or a weighted product without weight, is an explicit 400.
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
      // Quantize to the PERSISTED precision (OrderItem.weightQuantity is Decimal(12,3))
      // BEFORE any money math, so Order.total is always derivable from the stored
      // weightQuantity — a reprint or a >3-decimal scale reading can't diverge by a
      // cent (review 2026-07-19, fix #3). All downstream (total, persist, deduction)
      // uses this quantized value.
      const weightKg = rawWeightKg != null ? Math.round(rawWeightKg * 1000) / 1000 : null
      const weightedBase = weightKg != null ? Math.round(Number(product.price) * weightKg * 100) / 100 : null
      /** Line total for qty units — weight-aware (weighted lines: qty is 1). */
      const lineTotalFor = (qty: number) =>
        new Prisma.Decimal(weightedBase != null ? weightedBase + modifierTotal * qty : (Number(product.price) + modifierTotal) * qty)

      // ⭐ Idempotency: prefer externalId when provided
      const normalizedExternalId = normalizeExternalId(item.externalId)

      if (normalizedExternalId) {
        const existingByExternal = await prisma.orderItem.findFirst({
          where: {
            orderId: order.id,
            externalId: normalizedExternalId,
          },
          include: {
            product: {
              select: {
                id: true,
                name: true,
              },
            },
            modifiers: {
              include: {
                modifier: true,
              },
            },
          },
        })

        if (existingByExternal) {
          const updatedQuantity = item.quantity
          const updatedTotal = lineTotalFor(updatedQuantity)

          logger.info(
            `🔄 [ADD ITEMS] UPDATING by externalId: ${product.name} | old qty=${existingByExternal.quantity} → new qty=${updatedQuantity} | externalId=${normalizedExternalId}`,
          )

          const updatedItem = await prisma.orderItem.update({
            where: { id: existingByExternal.id },
            data: {
              quantity: updatedQuantity,
              total: updatedTotal,
              // Persist the re-weighed value: total is weight-aware (lineTotalFor),
              // so weightQuantity/weightUnit must move with it or the receipt +
              // inventory deduction go stale (review 2026-07-19, fix #1).
              weightQuantity: weightKg != null ? new Prisma.Decimal(weightKg) : null,
              weightUnit: weightKg != null ? ('KILOGRAM' as const) : null,
              notes: normalizedNotes ?? existingByExternal.notes,
              externalId: existingByExternal.externalId ?? normalizedExternalId,
            },
            include: {
              product: {
                select: {
                  id: true,
                  name: true,
                },
              },
              modifiers: {
                include: {
                  modifier: true,
                },
              },
            },
          })

          logger.info(`✅ [ADD ITEMS] UPDATED OrderItem by externalId: ${product.name} | qty=${updatedItem.quantity}`)
          return updatedItem
        }

        const existingById = await prisma.orderItem.findFirst({
          where: {
            id: normalizedExternalId,
            orderId: order.id,
          },
          include: {
            product: {
              select: {
                id: true,
                name: true,
              },
            },
            modifiers: {
              include: {
                modifier: true,
              },
            },
          },
        })

        if (existingById) {
          const updatedQuantity = item.quantity
          const updatedTotal = lineTotalFor(updatedQuantity)

          logger.info(
            `🔄 [ADD ITEMS] UPDATING by id fallback: ${product.name} | old qty=${existingById.quantity} → new qty=${updatedQuantity} | externalId=${normalizedExternalId}`,
          )

          const updatedItem = await prisma.orderItem.update({
            where: { id: existingById.id },
            data: {
              quantity: updatedQuantity,
              total: updatedTotal,
              weightQuantity: weightKg != null ? new Prisma.Decimal(weightKg) : null,
              weightUnit: weightKg != null ? ('KILOGRAM' as const) : null,
              notes: normalizedNotes ?? existingById.notes,
              externalId: existingById.externalId ?? normalizedExternalId,
            },
            include: {
              product: {
                select: {
                  id: true,
                  name: true,
                },
              },
              modifiers: {
                include: {
                  modifier: true,
                },
              },
            },
          })

          logger.info(`✅ [ADD ITEMS] UPDATED OrderItem by id fallback: ${product.name} | qty=${updatedItem.quantity}`)
          return updatedItem
        }

        // If externalId provided and no match, create new line (no merge)
        const itemTotal = lineTotalFor(item.quantity)
        const lineComped = item.isCortesia === true
        const createdItem = await prisma.orderItem.create({
          data: {
            orderId: order.id,
            productId: item.productId,
            productName: product.name,
            productSku: product.sku,
            categoryName: product.category?.name || null,
            quantity: item.quantity,
            unitPrice: product.price,
            weightQuantity: weightKg != null ? new Prisma.Decimal(weightKg) : null,
            weightUnit: weightKg != null ? ('KILOGRAM' as const) : null,
            discountAmount: lineComped ? itemTotal : 0,
            taxAmount: 0,
            total: lineComped ? 0 : itemTotal,
            isCortesia: lineComped,
            cortesiaReason: lineComped ? item.cortesiaReason?.trim() || null : null,
            notes: normalizedNotes,
            course: item.course ?? null,
            seat: item.seat ?? null,
            externalId: normalizedExternalId,
            modifiers: {
              create: itemModifiers.map(modifierId => {
                const modifier = modifiers.find(m => m.id === modifierId)!
                logger.info(`  📎 [ADD ITEMS] Creating OrderItemModifier: ${modifier.name} ($${modifier.price})`)
                return {
                  modifierId,
                  name: modifier.name,
                  quantity: 1,
                  price: modifier.price,
                }
              }),
            },
          },
          include: {
            product: {
              select: {
                id: true,
                name: true,
              },
            },
            modifiers: {
              include: {
                modifier: true,
              },
            },
          },
        })

        logger.info(`✅ [ADD ITEMS] CREATED OrderItem by externalId: ${product.name} | qty=${createdItem.quantity}`)
        return createdItem
      }

      // Sort modifier IDs for consistent comparison
      const sortedNewModifiers = [...itemModifiers].sort()

      // More precise check: query existing items with their modifiers and match by notes + modifiers
      const existingItemsWithModifiers = await prisma.orderItem.findMany({
        where: {
          orderId: order.id,
          productId: item.productId,
        },
        include: {
          modifiers: true,
        },
      })

      // D9 (venta por peso): weighted lines NEVER merge into an existing line —
      // every weighing is its own line, so the lookup is skipped entirely.
      // Cortesía: comped lines never merge either (in EITHER direction) — a
      // merge would silently swallow the $0 line into a paid one (money bug).
      const existingItemWithModifiers =
        asNewRound || weightKg != null || item.isCortesia === true
          ? undefined
          : existingItemsWithModifiers.find(existing => {
              if (existing.isCortesia) return false
              const existingModifierIds = existing.modifiers.map(m => m.modifierId).sort()
              const notesMatch = normalizeNotes(existing.notes) === normalizedNotes
              // TABLE_SERVICE: lines in different courses never merge.
              const courseMatch = (existing.course ?? null) === (item.course ?? null)
              // TABLE_SERVICE: lines for different seats never merge either.
              const seatMatch = (existing.seat ?? null) === (item.seat ?? null)
              return notesMatch && courseMatch && seatMatch && JSON.stringify(existingModifierIds) === JSON.stringify(sortedNewModifiers)
            })

      if (existingItemWithModifiers) {
        // ⭐ UPDATE existing item instead of creating new one
        const updatedQuantity = item._count > 1 ? existingItemWithModifiers.quantity + item.quantity : item.quantity
        const updatedTotal = lineTotalFor(updatedQuantity)

        logger.info(
          `🔄 [ADD ITEMS] UPDATING existing item: ${product.name} | old qty=${existingItemWithModifiers.quantity} → new qty=${updatedQuantity} | merged=${item._count > 1}`,
        )

        const updatedItem = await prisma.orderItem.update({
          where: { id: existingItemWithModifiers.id },
          data: {
            quantity: updatedQuantity,
            total: updatedTotal,
            // Clears a stale weight if a now-normal product merges into a line that
            // was weighed before soldByWeight was toggled off (review 2026-07-19).
            weightQuantity: weightKg != null ? new Prisma.Decimal(weightKg) : null,
            weightUnit: weightKg != null ? ('KILOGRAM' as const) : null,
            notes: normalizedNotes ?? existingItemWithModifiers.notes,
          },
          include: {
            product: {
              select: {
                id: true,
                name: true,
              },
            },
            modifiers: {
              include: {
                modifier: true,
              },
            },
          },
        })

        logger.info(`✅ [ADD ITEMS] UPDATED OrderItem: ${product.name} | qty=${updatedItem.quantity}`)
        return updatedItem
      }

      // Create NEW order item with modifiers (original behavior)
      // ✅ Toast/Square pattern: Denormalize product data for order history preservation
      const itemTotal = lineTotalFor(item.quantity)
      const plainComped = item.isCortesia === true
      const createdItem = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: item.productId,
          // Denormalized fields - preserved even if product is later deleted
          productName: product.name,
          productSku: product.sku,
          categoryName: product.category?.name || null,
          quantity: item.quantity,
          unitPrice: product.price,
          weightQuantity: weightKg != null ? new Prisma.Decimal(weightKg) : null,
          weightUnit: weightKg != null ? ('KILOGRAM' as const) : null,
          discountAmount: plainComped ? itemTotal : 0,
          taxAmount: 0,
          total: plainComped ? 0 : itemTotal,
          isCortesia: plainComped,
          cortesiaReason: plainComped ? item.cortesiaReason?.trim() || null : null,
          notes: normalizedNotes,
          course: item.course ?? null,
          seat: item.seat ?? null,
          sentToKitchenAt: roundSentAt,
          modifiers: {
            create: itemModifiers.map(modifierId => {
              const modifier = modifiers.find(m => m.id === modifierId)!
              logger.info(`  📎 [ADD ITEMS] Creating OrderItemModifier: ${modifier.name} ($${modifier.price})`)
              return {
                modifierId,
                // Denormalized modifier name - preserved even if modifier is later deleted
                name: modifier.name,
                quantity: 1,
                price: modifier.price,
              }
            }),
          },
        },
        include: {
          product: {
            select: {
              id: true,
              name: true,
            },
          },
          modifiers: {
            include: {
              modifier: true,
            },
          },
        },
      })

      logger.info(`✅ [ADD ITEMS] Created NEW OrderItem: ${product.name} with ${createdItem.modifiers.length} modifiers`)
      return createdItem
    }),
  )

  // ⭐ P0 FIX: Re-fetch all items from DB to avoid double-counting updated items
  // Previously we did [...order.items, ...newOrderItems] but this would duplicate
  // items that were UPDATED (old version + new version)
  const allItemsFromDb = await prisma.orderItem.findMany({
    where: { orderId: order.id },
  })
  const newSubtotal = allItemsFromDb.reduce((sum, item) => sum + Number(item.total), 0)

  // 🔄 Recalculate percentage-based discounts when items are added
  // Fetch any applied OrderDiscounts and recalculate PERCENTAGE discounts
  const orderDiscounts = await prisma.orderDiscount.findMany({
    where: { orderId },
    include: { discount: true },
  })

  let newDiscountAmount = 0
  for (const orderDiscount of orderDiscounts) {
    // 🔴 MONEY (auditoría 2026-07-18): filas con appliedToItemIds son descuentos
    // POR ARTÍCULO — su % NO se re-deriva sobre el subtotal completo. Y el valor
    // es el DENORMALIZADO de la fila, no el del catálogo vivo.
    const isItemScoped = ((orderDiscount as any).appliedToItemIds?.length ?? 0) > 0
    const discountType = orderDiscount.type
    const discountValue = Number(orderDiscount.value || 0)

    if (!isItemScoped && discountType === 'PERCENTAGE' && discountValue > 0) {
      // Recalculate percentage based on NEW subtotal
      const recalculatedAmount = (newSubtotal * discountValue) / 100
      const roundedAmount = Math.round(recalculatedAmount * 100) / 100

      logger.info(`  🔄 Recalculating PERCENTAGE discount: ${discountValue}% of $${newSubtotal} = $${roundedAmount}`)

      // Update individual OrderDiscount record
      await prisma.orderDiscount.update({
        where: { id: orderDiscount.id },
        data: { amount: roundedAmount },
      })

      newDiscountAmount += roundedAmount
    } else {
      // FIXED_AMOUNT or COUPON - keep original amount
      newDiscountAmount += Number(orderDiscount.amount)
    }
  }

  // If no OrderDiscounts but order has discountAmount, preserve it (from comp/manual discount)
  if (orderDiscounts.length === 0 && Number(order.discountAmount) > 0) {
    newDiscountAmount = Number(order.discountAmount)
  }

  // Cobros por servicio (auditoría 2026-07-18): agregar una ronda NO debe tirar
  // el cargo del total. Base = subtotal − descuentos; los % se re-calculan.
  const baseForCharges = Math.max(0, newSubtotal - newDiscountAmount)
  const orderServiceCharges = await prisma.orderServiceCharge.findMany({ where: { orderId } })
  let newServiceChargeAmount = 0
  for (const sc of orderServiceCharges) {
    const scAmount = sc.type === 'PERCENTAGE' ? Math.round(((baseForCharges * Number(sc.value)) / 100) * 100) / 100 : Number(sc.amount)
    if (sc.type === 'PERCENTAGE' && scAmount !== Number(sc.amount)) {
      await prisma.orderServiceCharge.update({ where: { id: sc.id }, data: { amount: scAmount } })
    }
    newServiceChargeAmount += scAmount
  }
  newServiceChargeAmount = Math.round(newServiceChargeAmount * 100) / 100

  const newTotal = Math.round((baseForCharges + newServiceChargeAmount) * 100) / 100

  // Calculate remaining balance (for partial payment tracking)
  const currentPaidAmount = Number(order.paidAmount || 0)
  const newRemainingBalance = Math.max(0, newTotal - currentPaidAmount)

  logger.info(`  📊 New totals: subtotal=$${newSubtotal}, discount=$${newDiscountAmount}, total=$${newTotal}`)

  // Update order with new totals and increment version
  const updatedOrder = await prisma.order.update({
    where: { id: orderId },
    data: {
      subtotal: newSubtotal,
      discountAmount: newDiscountAmount,
      serviceChargeAmount: newServiceChargeAmount,
      total: newTotal,
      remainingBalance: newRemainingBalance,
      version: {
        increment: 1,
      },
    },
    include: {
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
      payments: {
        include: {
          allocations: true,
        },
      },
      table: {
        select: {
          id: true,
          number: true,
        },
      },
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      servedBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  })

  logger.info(
    `✅ [ORDER SERVICE] Added ${newOrderItems.length} items to order ${order.orderNumber}. New total: $${newTotal} (version: ${order.version} → ${updatedOrder.version})`,
  )

  // Log modifier counts in final response
  updatedOrder.items.forEach(item => {
    const modifierCount = item.modifiers?.length || 0
    if (modifierCount > 0) {
      logger.info(`  📦 [RESPONSE] OrderItem ${item.product?.name || item.productName} has ${modifierCount} modifiers in response`)
      item.modifiers?.forEach(om => {
        logger.info(`     - ${om.modifier?.name || om.name}: $${om.price}`)
      })
    }
  })

  // Emit Socket.IO event for real-time order updates
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastToVenue(venueId, SocketEventType.ORDER_UPDATED, {
      orderId: updatedOrder.id,
      orderNumber: updatedOrder.orderNumber,
      tableId: updatedOrder.tableId,
      newItems: newOrderItems.map(item => ({
        id: item.id,
        productId: item.productId,
        productName: item.product?.name || item.productName || '',
        quantity: item.quantity,
        unitPrice: Number(item.unitPrice),
        total: Number(item.total),
      })),
      subtotal: Number(updatedOrder.subtotal),
      total: Number(updatedOrder.total),
      version: updatedOrder.version,
    })
  }

  // Construct table name for display in Android app
  const tableName = updatedOrder.table ? `Mesa ${updatedOrder.table.number}` : null

  return {
    ...flattenOrderModifiers(updatedOrder),
    tableName,
  }
}

interface UpdateGuestInfoInput {
  covers?: number
  customerName?: string | null
  customerPhone?: string | null
  specialRequests?: string | null
  customerId?: string | null
}

/**
 * Update guest information for an order
 * @param venueId Venue ID
 * @param orderId Order ID
 * @param guestInfo Guest information to update
 * @returns Updated order
 */
export async function updateGuestInfo(
  venueId: string,
  orderId: string,
  guestInfo: UpdateGuestInfoInput,
): Promise<Order & { tableName: string | null }> {
  logger.info(`👥 [ORDER SERVICE] Updating guest info for order ${orderId}`)

  // Fetch order
  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  // Validate covers if provided
  if (guestInfo.covers !== undefined && guestInfo.covers < 1) {
    throw new BadRequestError('Covers must be at least 1')
  }

  // Update order with new guest info
  const updatedOrder = await prisma.order.update({
    where: { id: orderId },
    data: {
      ...(guestInfo.covers !== undefined && { covers: guestInfo.covers }),
      ...(guestInfo.customerName !== undefined && { customerName: guestInfo.customerName }),
      ...(guestInfo.customerPhone !== undefined && { customerPhone: guestInfo.customerPhone }),
      ...(guestInfo.specialRequests !== undefined && { specialRequests: guestInfo.specialRequests }),
      ...(guestInfo.customerId !== undefined && { customerId: guestInfo.customerId }),
    },
    include: {
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
      payments: {
        include: {
          allocations: true,
        },
      },
      table: {
        select: {
          id: true,
          number: true,
        },
      },
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      servedBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  })

  logger.info(
    `✅ [ORDER SERVICE] Updated guest info for order ${order.orderNumber} | covers=${updatedOrder.covers} | customer=${updatedOrder.customerName || 'N/A'}`,
  )

  // Emit Socket.IO event for real-time updates
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastToVenue(venueId, SocketEventType.ORDER_UPDATED, {
      orderId: updatedOrder.id,
      orderNumber: updatedOrder.orderNumber,
      tableId: updatedOrder.tableId,
      covers: updatedOrder.covers,
      customerName: updatedOrder.customerName,
      guestInfoUpdated: true,
    })
  }

  const updatedTableName = updatedOrder.table ? `Mesa ${updatedOrder.table.number}` : null

  return {
    ...flattenOrderModifiers(updatedOrder),
    tableName: updatedTableName,
  }
}

/**
 * Remove an item from an existing order with optimistic concurrency control
 * @param venueId Venue ID
 * @param orderId Order ID
 * @param orderItemId Item ID to remove
 * @param expectedVersion Expected version number for optimistic locking
 * @returns Updated order without the removed item
 */
export async function removeOrderItem(
  venueId: string,
  orderId: string,
  orderItemId: string,
  expectedVersion: number,
): Promise<Order & { tableName: string | null }> {
  logger.info(`🗑️ [ORDER SERVICE] Removing item ${orderItemId} from order ${orderId} (expected version: ${expectedVersion})`)

  // Fetch order with version check
  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
    include: {
      items: {
        include: {
          product: true,
        },
      },
    },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  // Optimistic concurrency check
  // ✅ P1 FIX: Use 409 Conflict instead of 400 Bad Request for version mismatch
  if (order.version !== expectedVersion) {
    logger.warn(
      `⚠️ [ORDER SERVICE] Version mismatch! Expected: ${expectedVersion}, Got: ${order.version}. Order was modified by another request.`,
    )
    throw new ConflictError(
      `Order was modified by another request. Please refresh and try again. (Expected version: ${expectedVersion}, Current: ${order.version})`,
    )
  }

  // Validate order is not paid
  if (order.paymentStatus === 'PAID') {
    throw new BadRequestError('Cannot remove items from a paid order')
  }

  // Verify item exists in order
  const itemToRemove = order.items.find(item => item.id === orderItemId)
  if (!itemToRemove) {
    throw new NotFoundError('Order item not found in this order')
  }

  // Delete the order item (Prisma will cascade delete modifiers)
  await prisma.orderItem.delete({
    where: { id: orderItemId },
  })

  logger.info(`✅ [ORDER SERVICE] Deleted item: ${itemToRemove.product?.name || itemToRemove.productName} (${itemToRemove.id})`)

  // Calculate new totals
  const remainingItems = order.items.filter(item => item.id !== orderItemId)
  const newSubtotal = remainingItems.reduce((sum, item) => sum + Number(item.total), 0)

  // 🔄 Recalculate percentage-based discounts when items are removed
  // Fetch any applied OrderDiscounts and recalculate PERCENTAGE discounts
  const orderDiscounts = await prisma.orderDiscount.findMany({
    where: { orderId },
    include: { discount: true },
  })

  let newDiscountAmount = 0
  for (const orderDiscount of orderDiscounts) {
    // 🔴 MONEY (auditoría 2026-07-18): filas con appliedToItemIds son descuentos
    // POR ARTÍCULO — su % NO se re-deriva sobre el subtotal completo. Y el valor
    // es el DENORMALIZADO de la fila, no el del catálogo vivo.
    const isItemScoped = ((orderDiscount as any).appliedToItemIds?.length ?? 0) > 0
    const discountType = orderDiscount.type
    const discountValue = Number(orderDiscount.value || 0)

    if (!isItemScoped && discountType === 'PERCENTAGE' && discountValue > 0) {
      // Recalculate percentage based on NEW subtotal
      const recalculatedAmount = (newSubtotal * discountValue) / 100
      const roundedAmount = Math.round(recalculatedAmount * 100) / 100

      logger.info(`  🔄 Recalculating PERCENTAGE discount: ${discountValue}% of $${newSubtotal} = $${roundedAmount}`)

      // Update individual OrderDiscount record
      await prisma.orderDiscount.update({
        where: { id: orderDiscount.id },
        data: { amount: roundedAmount },
      })

      newDiscountAmount += roundedAmount
    } else {
      // FIXED_AMOUNT or COUPON - keep original amount
      newDiscountAmount += Number(orderDiscount.amount)
    }
  }

  // If no OrderDiscounts but order has discountAmount, preserve it (from comp/manual discount)
  if (orderDiscounts.length === 0 && Number(order.discountAmount) > 0) {
    newDiscountAmount = Number(order.discountAmount)
  }

  // Cobros por servicio (auditoría 2026-07-18): agregar una ronda NO debe tirar
  // el cargo del total. Base = subtotal − descuentos; los % se re-calculan.
  const baseForCharges = Math.max(0, newSubtotal - newDiscountAmount)
  const orderServiceCharges = await prisma.orderServiceCharge.findMany({ where: { orderId } })
  let newServiceChargeAmount = 0
  for (const sc of orderServiceCharges) {
    const scAmount = sc.type === 'PERCENTAGE' ? Math.round(((baseForCharges * Number(sc.value)) / 100) * 100) / 100 : Number(sc.amount)
    if (sc.type === 'PERCENTAGE' && scAmount !== Number(sc.amount)) {
      await prisma.orderServiceCharge.update({ where: { id: sc.id }, data: { amount: scAmount } })
    }
    newServiceChargeAmount += scAmount
  }
  newServiceChargeAmount = Math.round(newServiceChargeAmount * 100) / 100

  const newTotal = Math.round((baseForCharges + newServiceChargeAmount) * 100) / 100

  // Calculate remaining balance (for partial payment tracking)
  const currentPaidAmount = Number(order.paidAmount || 0)
  const newRemainingBalance = Math.max(0, newTotal - currentPaidAmount)

  logger.info(`  📊 New totals: subtotal=$${newSubtotal}, discount=$${newDiscountAmount}, total=$${newTotal}`)

  // Update order with new totals and increment version
  const updatedOrder = await prisma.order.update({
    where: { id: orderId },
    data: {
      subtotal: newSubtotal,
      discountAmount: newDiscountAmount,
      total: newTotal,
      remainingBalance: newRemainingBalance,
      version: {
        increment: 1,
      },
    },
    include: {
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
      payments: {
        include: {
          allocations: true,
        },
      },
      table: {
        select: {
          id: true,
          number: true,
        },
      },
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      servedBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  })

  logger.info(
    `✅ [ORDER SERVICE] Removed item from order ${order.orderNumber}. New total: $${newTotal} (version: ${order.version} → ${updatedOrder.version})`,
  )
  void logAction({
    staffId: null,
    venueId,
    action: 'ITEM_REMOVED',
    entity: 'Order',
    entityId: orderId,
    data: { itemId: orderItemId, amount: Number(itemToRemove.total ?? 0) },
  })

  // Emit Socket.IO event for real-time order updates
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastToVenue(venueId, SocketEventType.ORDER_UPDATED, {
      orderId: updatedOrder.id,
      orderNumber: updatedOrder.orderNumber,
      tableId: updatedOrder.tableId,
      removedItemId: orderItemId,
      subtotal: Number(updatedOrder.subtotal),
      total: Number(updatedOrder.total),
      version: updatedOrder.version,
    })
  }

  // Construct table name for display in Android app
  const tableName = updatedOrder.table ? `Mesa ${updatedOrder.table.number}` : null

  return {
    ...flattenOrderModifiers(updatedOrder),
    tableName,
  }
}

// ==========================================
// ORDER ACTIONS (Comp, Void, Discount)
// ==========================================

interface CompItemsInput {
  itemIds: string[] // Items to comp (empty array = comp entire order)
  reason: string // Required: "Food quality issue", "Long wait time", etc.
  staffId: string // Staff member performing the action
  notes?: string
}

/**
 * Comp (complimentary) items or entire order
 * Removes cost from delivered items (for service recovery)
 * @param venueId Venue ID
 * @param orderId Order ID
 * @param input Comp details
 * @returns Updated order with comped items
 */
export async function compItems(venueId: string, orderId: string, input: CompItemsInput): Promise<Order & { tableName: string | null }> {
  logger.info(`🚫 [ORDER SERVICE] Comping items for order ${orderId} | reason: ${input.reason}`)

  // Fetch order
  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
    include: {
      items: true,
    },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  // Validate order is not already paid
  if (order.paymentStatus === 'PAID') {
    throw new BadRequestError('Cannot comp items from a paid order')
  }

  // Validate staff exists
  const staff = await prisma.staff.findUnique({
    where: { id: input.staffId },
  })

  if (!staff) {
    throw new NotFoundError('Staff member not found')
  }

  // Determine which items to comp
  const itemsToComp =
    input.itemIds.length === 0
      ? order.items // Comp entire order
      : order.items.filter(item => input.itemIds.includes(item.id))

  if (itemsToComp.length === 0) {
    throw new BadRequestError('No items found to comp')
  }

  // Calculate discount amount (total of comped items)
  const compAmount = itemsToComp.reduce((sum, item) => sum + Number(item.total), 0)

  logger.info(`  💰 Comping ${itemsToComp.length} items | total discount: $${compAmount}`)

  // Update order: increase discountAmount, decrease total
  const newDiscountAmount = Number(order.discountAmount) + compAmount
  const newTotal = Number(order.subtotal) - newDiscountAmount

  // Calculate remaining balance (for partial payment tracking)
  const currentPaidAmount = Number(order.paidAmount || 0)
  const newRemainingBalance = Math.max(0, newTotal - currentPaidAmount)

  const updatedOrder = await prisma.order.update({
    where: { id: orderId },
    data: {
      discountAmount: newDiscountAmount,
      total: newTotal,
      remainingBalance: newRemainingBalance,
      version: {
        increment: 1,
      },
    },
    include: {
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
      payments: {
        include: {
          allocations: true,
        },
      },
      table: {
        select: {
          id: true,
          number: true,
        },
      },
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      servedBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  })

  // Create audit trail
  await prisma.orderAction.create({
    data: {
      orderId: order.id,
      actionType: 'COMP',
      performedById: input.staffId,
      reason: input.reason,
      metadata: {
        itemIds: input.itemIds,
        compAmount,
        itemCount: itemsToComp.length,
        notes: input.notes,
      },
    },
  })
  void logAction({
    staffId: input.staffId ?? null,
    venueId,
    action: 'ITEM_COMPED',
    entity: 'Order',
    entityId: orderId,
    data: { itemIds: input.itemIds, amount: Number(compAmount), reason: input.reason ?? undefined },
  })

  logger.info(`✅ [ORDER SERVICE] Comped ${itemsToComp.length} items | discount: $${compAmount} | new total: $${newTotal}`)

  // Emit Socket.IO event
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastToVenue(venueId, SocketEventType.ORDER_UPDATED, {
      orderId: updatedOrder.id,
      orderNumber: updatedOrder.orderNumber,
      tableId: updatedOrder.tableId,
      actionType: 'COMP',
      compAmount,
      total: Number(updatedOrder.total),
      version: updatedOrder.version,
    })
  }

  const compTableName = updatedOrder.table ? `Mesa ${updatedOrder.table.number}` : null

  return {
    ...flattenOrderModifiers(updatedOrder),
    tableName: compTableName,
  }
}

interface VoidItemsInput {
  itemIds: string[] // Items to void
  reason: string // Required: "Wrong item entered", "Customer changed mind", etc.
  staffId: string // Staff member performing the action
  expectedVersion: number // Optimistic locking
}

/**
 * Void (cancel) items from an order
 * Completely removes items that were entered by mistake (before kitchen preparation)
 * @param venueId Venue ID
 * @param orderId Order ID
 * @param input Void details
 * @returns Updated order without voided items
 */
export async function voidItems(venueId: string, orderId: string, input: VoidItemsInput): Promise<Order & { tableName: string | null }> {
  logger.info(`❌ [ORDER SERVICE] Voiding ${input.itemIds.length} items from order ${orderId} | reason: ${input.reason}`)

  // Fetch order with version check
  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
    include: {
      items: {
        include: {
          product: true,
        },
      },
    },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  // Optimistic concurrency check
  // ✅ P1 FIX: Use 409 Conflict instead of 400 Bad Request for version mismatch
  if (order.version !== input.expectedVersion) {
    logger.warn(`⚠️ [ORDER SERVICE] Version mismatch! Expected: ${input.expectedVersion}, Got: ${order.version}`)
    throw new ConflictError(
      `Order was modified by another request. Please refresh and try again. (Expected version: ${input.expectedVersion}, Current: ${order.version})`,
    )
  }

  // Validate order is not paid
  if (order.paymentStatus === 'PAID') {
    throw new BadRequestError('Cannot void items from a paid order')
  }

  // Validate staff exists
  const staff = await prisma.staff.findUnique({
    where: { id: input.staffId },
  })

  if (!staff) {
    throw new NotFoundError('Staff member not found')
  }

  // Find items to void
  const itemsToVoid = order.items.filter(item => input.itemIds.includes(item.id))

  if (itemsToVoid.length === 0) {
    throw new BadRequestError('No items found to void')
  }

  if (itemsToVoid.length !== input.itemIds.length) {
    throw new BadRequestError('Some item IDs were not found in this order')
  }

  // Check if any items already sent to kitchen (optional warning, but still allow void)
  const sentToKitchen = itemsToVoid.filter(item => item.sentToKitchenAt !== null)
  if (sentToKitchen.length > 0) {
    logger.warn(`⚠️ [ORDER SERVICE] Voiding ${sentToKitchen.length} items already sent to kitchen. Kitchen may need notification.`)
  }

  // Calculate void amount (for audit trail)
  const voidAmount = itemsToVoid.reduce((sum, item) => sum + Number(item.total), 0)

  logger.info(`  💰 Voiding ${itemsToVoid.length} items | total voided: $${voidAmount}`)

  // Delete the items (Prisma cascades to OrderItemModifier)
  await prisma.orderItem.deleteMany({
    where: {
      id: {
        in: input.itemIds,
      },
    },
  })

  // Calculate new totals
  const remainingItems = order.items.filter(item => !input.itemIds.includes(item.id))
  const newSubtotal = remainingItems.reduce((sum, item) => sum + Number(item.total), 0)
  const newTotal = newSubtotal - Number(order.discountAmount)

  // Calculate remaining balance (for partial payment tracking)
  const currentPaidAmount = Number(order.paidAmount || 0)
  const newRemainingBalance = Math.max(0, newTotal - currentPaidAmount)

  // ⭐ FIX: Auto-close order if voiding all items (Toast/Square pattern)
  // When 0 items remain, order should be cancelled and removed from active list
  const isVoidingAllItems = remainingItems.length === 0

  if (isVoidingAllItems) {
    logger.info(`🚫 [ORDER SERVICE] Voiding ALL items - auto-closing order ${orderId}`)
  }

  // Update order with new totals and increment version
  const updatedOrder = await prisma.order.update({
    where: { id: orderId },
    data: {
      subtotal: newSubtotal,
      total: newTotal,
      remainingBalance: newRemainingBalance,
      // ⭐ If voiding all items, auto-close order (Toast/Square pattern)
      ...(isVoidingAllItems && {
        status: 'CANCELLED',
        paymentStatus: 'PENDING', // Keep PENDING (order was never paid)
      }),
      version: {
        increment: 1,
      },
    },
    include: {
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
      payments: {
        include: {
          allocations: true,
        },
      },
      table: {
        select: {
          id: true,
          number: true,
        },
      },
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      servedBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  })

  // ⭐ If voided all items, remove customer linkages (pay-later orders)
  // No point keeping "cuenta por cobrar" for $0.00 order with 0 items (Toast/Square pattern)
  if (isVoidingAllItems) {
    const deletedCustomers = await prisma.orderCustomer.deleteMany({
      where: { orderId },
    })

    if (deletedCustomers.count > 0) {
      logger.info(`  👥 Removed ${deletedCustomers.count} customer linkage(s) from voided order`)
    }
  }

  // Create audit trail
  await prisma.orderAction.create({
    data: {
      orderId: order.id,
      actionType: 'VOID',
      performedById: input.staffId,
      reason: input.reason,
      metadata: {
        itemIds: input.itemIds,
        voidAmount,
        itemCount: itemsToVoid.length,
        itemNames: itemsToVoid.map(item => item.product?.name || item.productName),
        sentToKitchen: sentToKitchen.length > 0,
        voidedAllItems: isVoidingAllItems, // ⭐ Track if order was auto-closed
      },
    },
  })
  void logAction({
    staffId: input.staffId ?? null,
    venueId,
    action: 'ITEM_VOIDED',
    entity: 'Order',
    entityId: orderId,
    data: { itemIds: input.itemIds, amount: Number(voidAmount), reason: input.reason ?? undefined },
  })

  logger.info(`✅ [ORDER SERVICE] Voided ${itemsToVoid.length} items | voided amount: $${voidAmount} | new total: $${newTotal}`)

  // Emit Socket.IO event
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastToVenue(venueId, SocketEventType.ORDER_UPDATED, {
      orderId: updatedOrder.id,
      orderNumber: updatedOrder.orderNumber,
      tableId: updatedOrder.tableId,
      actionType: 'VOID',
      voidedItemIds: input.itemIds,
      voidAmount,
      subtotal: Number(updatedOrder.subtotal),
      total: Number(updatedOrder.total),
      version: updatedOrder.version,
      // ⭐ If voided all items, notify clients that order was auto-closed
      ...(isVoidingAllItems && {
        voidedAllItems: true,
        status: updatedOrder.status, // CANCELLED
        paymentStatus: updatedOrder.paymentStatus, // PENDING
      }),
    })
  }

  const voidTableName = updatedOrder.table ? `Mesa ${updatedOrder.table.number}` : null

  return {
    ...flattenOrderModifiers(updatedOrder),
    tableName: voidTableName,
  }
}

interface ApplyDiscountInput {
  type: 'PERCENTAGE' | 'FIXED_AMOUNT'
  value: number // Percentage (0-100) or fixed amount
  reason?: string // Optional for promotional discounts
  staffId: string // Staff member performing the action
  itemIds?: string[] // Optional: apply to specific items (null = order-level)
  expectedVersion: number // Optimistic locking
}

/**
 * Apply discount to order or specific items
 * @param venueId Venue ID
 * @param orderId Order ID
 * @param input Discount details
 * @returns Updated order with discount applied
 */
export async function applyDiscount(
  venueId: string,
  orderId: string,
  input: ApplyDiscountInput,
): Promise<Order & { tableName: string | null }> {
  logger.info(`💰 [ORDER SERVICE] Applying ${input.type} discount to order ${orderId} | value: ${input.value}`)

  // Fetch order with version check
  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
    include: {
      items: true,
    },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  // Optimistic concurrency check
  if (order.version !== input.expectedVersion) {
    logger.warn(`⚠️ [ORDER SERVICE] Version mismatch! Expected: ${input.expectedVersion}, Got: ${order.version}`)
    throw new BadRequestError(
      `Order was modified by another request. Please refresh and try again. (Expected version: ${input.expectedVersion}, Current: ${order.version})`,
    )
  }

  // Validate order is not paid
  if (order.paymentStatus === 'PAID') {
    throw new BadRequestError('Cannot apply discount to a paid order')
  }

  // Validate staff exists
  const staff = await prisma.staff.findUnique({
    where: { id: input.staffId },
  })

  if (!staff) {
    throw new NotFoundError('Staff member not found')
  }

  // Validate discount value
  if (input.type === 'PERCENTAGE') {
    if (input.value < 0 || input.value > 100) {
      throw new BadRequestError('Percentage discount must be between 0 and 100')
    }
  } else {
    if (input.value < 0) {
      throw new BadRequestError('Fixed discount amount cannot be negative')
    }
  }

  // Calculate discount amount
  let discountAmount: number

  if (input.itemIds && input.itemIds.length > 0) {
    // Item-level discount
    const itemsToDiscount = order.items.filter(item => input.itemIds!.includes(item.id))
    if (itemsToDiscount.length === 0) {
      throw new BadRequestError('No items found to apply discount')
    }

    const itemsSubtotal = itemsToDiscount.reduce((sum, item) => sum + Number(item.total), 0)

    if (input.type === 'PERCENTAGE') {
      discountAmount = (itemsSubtotal * input.value) / 100
    } else {
      discountAmount = Math.min(input.value, itemsSubtotal) // Can't discount more than item total
    }
  } else {
    // Order-level discount
    const orderSubtotal = Number(order.subtotal)

    if (input.type === 'PERCENTAGE') {
      discountAmount = (orderSubtotal * input.value) / 100
    } else {
      discountAmount = Math.min(input.value, orderSubtotal) // Can't discount more than order total
    }
  }

  // Round to 2 decimal places
  discountAmount = Math.round(discountAmount * 100) / 100

  logger.info(`  💰 Calculated discount: $${discountAmount}`)

  // Update order: add to existing discount
  const newDiscountAmount = Number(order.discountAmount) + discountAmount
  const newTotal = Number(order.subtotal) - newDiscountAmount

  // Calculate remaining balance (for partial payment tracking)
  const currentPaidAmount = Number(order.paidAmount || 0)
  const newRemainingBalance = Math.max(0, newTotal - currentPaidAmount)

  const updatedOrder = await prisma.order.update({
    where: { id: orderId },
    data: {
      discountAmount: newDiscountAmount,
      total: newTotal,
      remainingBalance: newRemainingBalance,
      version: {
        increment: 1,
      },
    },
    include: {
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
      payments: {
        include: {
          allocations: true,
        },
      },
      table: {
        select: {
          id: true,
          number: true,
        },
      },
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      servedBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  })

  // Create audit trail
  await prisma.orderAction.create({
    data: {
      orderId: order.id,
      actionType: 'DISCOUNT',
      performedById: input.staffId,
      reason: input.reason || 'Discount applied',
      metadata: {
        discountType: input.type,
        discountValue: input.value,
        discountAmount,
        itemIds: input.itemIds || [],
        itemLevel: !!input.itemIds,
      },
    },
  })
  void logAction({
    staffId: input.staffId ?? null,
    venueId,
    action: 'DISCOUNT_APPLIED',
    entity: 'Order',
    entityId: orderId,
    data: { amount: Number(discountAmount), reason: input.reason ?? undefined },
  })

  logger.info(`✅ [ORDER SERVICE] Applied discount | amount: $${discountAmount} | new total: $${newTotal}`)

  // Emit Socket.IO event
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastToVenue(venueId, SocketEventType.ORDER_UPDATED, {
      orderId: updatedOrder.id,
      orderNumber: updatedOrder.orderNumber,
      tableId: updatedOrder.tableId,
      actionType: 'DISCOUNT',
      discountAmount,
      total: Number(updatedOrder.total),
      version: updatedOrder.version,
    })
  }

  const discountTableName = updatedOrder.table ? `Mesa ${updatedOrder.table.number}` : null

  return {
    ...flattenOrderModifiers(updatedOrder),
    tableName: discountTableName,
  }
}

// ============================================================================
// Order-Customer Relationship Functions (Multi-Customer Support)
// ============================================================================

/**
 * Get all customers associated with an order
 */
export async function getOrderCustomers(venueId: string, orderId: string) {
  logger.info(`👥 [ORDER SERVICE] Getting customers for order ${orderId}`)

  // Verify order exists and belongs to venue
  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
    select: { id: true },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  const orderCustomers = await prisma.orderCustomer.findMany({
    where: { orderId },
    include: {
      customer: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          loyaltyPoints: true,
          totalVisits: true,
          totalSpent: true,
          customerGroupId: true,
          customerGroup: {
            select: {
              id: true,
              name: true,
              color: true,
            },
          },
          tags: true,
        },
      },
    },
    orderBy: { addedAt: 'asc' },
  })

  logger.info(`✅ [ORDER SERVICE] Found ${orderCustomers.length} customers for order ${orderId}`)

  return orderCustomers
}

/**
 * Add a customer to an order (multi-customer support)
 * First customer added becomes primary (receives loyalty points)
 */
export async function addCustomerToOrder(venueId: string, orderId: string, customerId: string) {
  logger.info(`👤 [ORDER SERVICE] Adding customer ${customerId} to order ${orderId}`)

  // Verify order exists and belongs to venue
  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
    select: { id: true, orderNumber: true },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  // Verify customer exists and belongs to venue
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { id: true, venueId: true, firstName: true, lastName: true },
  })

  if (!customer || customer.venueId !== venueId) {
    throw new NotFoundError('Customer not found')
  }

  // Check if customer already added to order
  const existingAssociation = await prisma.orderCustomer.findUnique({
    where: { orderId_customerId: { orderId, customerId } },
  })

  if (existingAssociation) {
    throw new BadRequestError('Customer already added to this order')
  }

  // 🔒 RACE CONDITION FIX: Use Serializable isolation to prevent multiple primaries
  // Combined with partial unique index on (orderId) WHERE isPrimary=true as defense-in-depth
  // Retry up to 5 times on serialization conflicts with exponential backoff
  const MAX_RETRIES = 5

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await prisma.$transaction(
        async tx => {
          // Check if this will be the first customer (primary) - inside transaction for consistency
          const existingCustomersCount = await tx.orderCustomer.count({
            where: { orderId },
          })
          const isPrimary = existingCustomersCount === 0

          // Add customer to order
          await tx.orderCustomer.create({
            data: {
              orderId,
              customerId,
              isPrimary,
            },
          })

          return { isPrimary }
        },
        {
          isolationLevel: 'Serializable', // Prevents race conditions
          timeout: 10000, // 10 second timeout
        },
      )

      logger.info(
        `✅ [ORDER SERVICE] Added customer ${customer.firstName || 'N/A'} ${customer.lastName || ''} to order ${order.orderNumber} | isPrimary=${result.isPrimary}`,
      )
      // Success - exit the retry loop
      break
    } catch (error: any) {
      // Handle unique constraint violation (partial unique index on isPrimary)
      if (error.code === 'P2002') {
        logger.warn(`⚠️ [ORDER SERVICE] Race condition detected - another customer was set as primary simultaneously`)
        // The customer was likely added with isPrimary=false due to timing, which is correct behavior
        // Re-check and add with isPrimary=false
        const existingAfterRace = await prisma.orderCustomer.findUnique({
          where: { orderId_customerId: { orderId, customerId } },
        })
        if (!existingAfterRace) {
          await prisma.orderCustomer.create({
            data: { orderId, customerId, isPrimary: false },
          })
          logger.info(`✅ [ORDER SERVICE] Added customer as non-primary after race condition resolution`)
        }
        break // Successfully handled
      } else if (error.code === 'P2034') {
        // Serialization failure - another transaction was modifying the same data
        logger.warn(`⚠️ [ORDER SERVICE] Serialization conflict, retrying... (attempt ${attempt}/${MAX_RETRIES})`)
        if (attempt < MAX_RETRIES) {
          // Exponential backoff: 50ms, 100ms, 200ms, 400ms, 800ms
          await new Promise(resolve => setTimeout(resolve, 50 * Math.pow(2, attempt - 1)))
          continue // Retry
        }
        // Max retries reached
        throw new BadRequestError('Conflicto de concurrencia persistente, por favor intente de nuevo')
      } else {
        throw error
      }
    }
  }

  // Return updated list of order customers
  return getOrderCustomers(venueId, orderId)
}

/**
 * Remove a customer from an order
 * If removing primary customer, the next oldest customer becomes primary
 */
export async function removeCustomerFromOrder(venueId: string, orderId: string, customerId: string) {
  logger.info(`🗑️ [ORDER SERVICE] Removing customer ${customerId} from order ${orderId}`)

  // Verify order exists and belongs to venue
  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
    select: { id: true, orderNumber: true },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  // Find the association to remove
  const association = await prisma.orderCustomer.findUnique({
    where: { orderId_customerId: { orderId, customerId } },
  })

  if (!association) {
    throw new NotFoundError('Customer not associated with this order')
  }

  const wasPrimary = association.isPrimary

  // Remove the association
  await prisma.orderCustomer.delete({
    where: { orderId_customerId: { orderId, customerId } },
  })

  // If removed customer was primary, promote the next oldest customer
  if (wasPrimary) {
    const nextCustomer = await prisma.orderCustomer.findFirst({
      where: { orderId },
      orderBy: { addedAt: 'asc' },
    })

    if (nextCustomer) {
      await prisma.orderCustomer.update({
        where: { id: nextCustomer.id },
        data: { isPrimary: true },
      })
      logger.info(`👑 [ORDER SERVICE] Promoted customer ${nextCustomer.customerId} to primary for order ${orderId}`)
    }
  }

  logger.info(`✅ [ORDER SERVICE] Removed customer from order ${order.orderNumber}`)

  // Return updated list of order customers
  return getOrderCustomers(venueId, orderId)
}

/**
 * Create a new customer and immediately add them to an order
 * Allows creating customer with minimal info (firstName OR phone OR email)
 */
export async function createAndAddCustomerToOrder(
  venueId: string,
  orderId: string,
  customerData: { firstName?: string; phone?: string; email?: string },
) {
  logger.info(`🆕 [ORDER SERVICE] Creating customer and adding to order ${orderId}`)

  // Normalize email to lowercase for consistent lookups
  const normalizedEmail = customerData.email?.toLowerCase()

  // Verify order exists and belongs to venue
  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
    select: { id: true, orderNumber: true },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  // Check for duplicate email/phone in venue (if provided)
  if (normalizedEmail) {
    const existingByEmail = await prisma.customer.findUnique({
      where: { venueId_email: { venueId, email: normalizedEmail } },
    })
    if (existingByEmail) {
      throw new BadRequestError('Ya existe un cliente con ese email en este venue')
    }
  }

  if (customerData.phone) {
    const existingByPhone = await prisma.customer.findUnique({
      where: { venueId_phone: { venueId, phone: customerData.phone } },
    })
    if (existingByPhone) {
      throw new BadRequestError('Ya existe un cliente con ese teléfono en este venue')
    }
  }

  // 🔒 RACE CONDITION FIX: Create customer and add to order in Serializable transaction
  // Combined with partial unique index on (orderId) WHERE isPrimary=true as defense-in-depth
  // Retry up to 5 times on serialization conflicts with exponential backoff
  const MAX_RETRIES = 5

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await prisma.$transaction(
        async tx => {
          // Check if this will be the first customer (primary) - INSIDE transaction for consistency
          const existingCustomersCount = await tx.orderCustomer.count({
            where: { orderId },
          })
          const isPrimary = existingCustomersCount === 0

          // Create the customer
          const newCustomer = await tx.customer.create({
            data: {
              venueId,
              firstName: customerData.firstName || null,
              phone: customerData.phone || null,
              email: normalizedEmail || null,
              firstVisitAt: new Date(),
            },
          })

          // Add to order
          await tx.orderCustomer.create({
            data: {
              orderId,
              customerId: newCustomer.id,
              isPrimary,
            },
          })

          logger.info(
            `✅ [ORDER SERVICE] Created customer ${newCustomer.id} and added to order ${order.orderNumber} | isPrimary=${isPrimary}`,
          )
        },
        {
          isolationLevel: 'Serializable', // Prevents race conditions
          timeout: 10000, // 10 second timeout
        },
      )
      // Success - exit the retry loop
      break
    } catch (error: any) {
      // Handle unique constraint violation (partial unique index on isPrimary)
      if (error.code === 'P2002') {
        // Could be duplicate email/phone OR isPrimary constraint
        if (error.meta?.target?.includes('email')) {
          throw new BadRequestError('Ya existe un cliente con ese email en este venue')
        }
        if (error.meta?.target?.includes('phone')) {
          throw new BadRequestError('Ya existe un cliente con ese teléfono en este venue')
        }
        // isPrimary constraint - this shouldn't happen in normal flow due to count check
        logger.warn(`⚠️ [ORDER SERVICE] Race condition on isPrimary detected during createAndAdd`)
        throw new BadRequestError('Conflicto de concurrencia, por favor intente de nuevo')
      } else if (error.code === 'P2034') {
        // Serialization failure - retry with exponential backoff
        logger.warn(`⚠️ [ORDER SERVICE] Serialization conflict in createAndAddCustomerToOrder (attempt ${attempt}/${MAX_RETRIES})`)
        if (attempt < MAX_RETRIES) {
          // Exponential backoff: 50ms, 100ms, 200ms, 400ms, 800ms
          await new Promise(resolve => setTimeout(resolve, 50 * Math.pow(2, attempt - 1)))
          continue // Retry
        }
        // Max retries reached
        throw new BadRequestError('Conflicto de concurrencia persistente, por favor intente de nuevo')
      } else {
        throw error
      }
    }
  }

  // Return updated list of order customers
  return getOrderCustomers(venueId, orderId)
}

// ==========================================
// SERIALIZED INVENTORY - Mixed Cart Support
// For items with unique barcodes (SIMs, jewelry, electronics)
// ==========================================

interface AddSerializedItemInput {
  serialNumber: string
  categoryId?: string // Required if item not registered
  price: number // Cashier-entered price (SerializedItem has no price field)
  notes?: string | null
}

/**
 * Add a serialized item to an existing order (mixed cart support).
 * Handles both registered and unregistered items.
 *
 * @param venueId Venue ID
 * @param orderId Order ID
 * @param input Serialized item details
 * @param expectedVersion Expected order version for optimistic locking
 * @param staffId Staff ID performing the action
 */
export async function addSerializedItemToOrder(
  venueId: string,
  orderId: string,
  input: AddSerializedItemInput,
  expectedVersion: number,
  staffId: string,
): Promise<Order & { tableName: string | null }> {
  logger.info(`📦 [ORDER SERVICE] Adding serialized item ${input.serialNumber} to order ${orderId}`)

  // Verify module is enabled for this venue
  const isEnabled = await moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY)
  if (!isEnabled) {
    throw new BadRequestError('Serialized inventory module is not enabled for this venue')
  }

  // Scan to check item status
  const scanResult = await serializedInventoryService.scan(venueId, input.serialNumber)

  if (scanResult.status === 'already_sold') {
    throw new BadRequestError(`Item ${input.serialNumber} ya fue vendido`)
  }

  if (scanResult.status === 'module_disabled') {
    throw new BadRequestError('Módulo de inventario serializado no habilitado')
  }

  // Get the order with optimistic locking check
  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
    select: {
      id: true,
      orderNumber: true,
      version: true,
      subtotal: true,
      total: true,
      discountAmount: true,
      paymentStatus: true,
    },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  if (order.version !== expectedVersion) {
    throw new ConflictError('Order was modified by another user. Please refresh and try again.')
  }

  if (order.paymentStatus === 'PAID') {
    throw new BadRequestError('Cannot add items to a paid order')
  }

  // Use transaction to ensure atomicity
  const result = await prisma.$transaction(async tx => {
    let serializedItemWithCategory: Awaited<ReturnType<typeof serializedInventoryService.getItemBySerialNumber>>

    if (scanResult.found && scanResult.item) {
      // Item exists - use it
      serializedItemWithCategory = scanResult.item
    } else {
      // Item doesn't exist - register it
      if (!input.categoryId) {
        throw new BadRequestError('categoryId is required for unregistered items')
      }

      serializedItemWithCategory = await serializedInventoryService.register({
        venueId,
        categoryId: input.categoryId,
        serialNumber: input.serialNumber,
        createdBy: staffId,
      })
    }

    // Build OrderItem data with proper snapshot fields
    const orderItemData = serializedInventoryService.buildOrderItemData(serializedItemWithCategory!, input.price)

    // Create OrderItem
    const orderItem = await tx.orderItem.create({
      data: {
        orderId,
        ...orderItemData, // Includes: productName, productSku, unitPrice, quantity, total, taxAmount, productId
        notes: input.notes,
      },
    })

    // Mark serialized item as sold (must use tx to reference the OrderItem created in this transaction)
    // Plan §1.5 — pass staffId so the custody precheck runs (OFF/WARN/ENFORCE per org).
    await serializedInventoryService.markAsSold(venueId, input.serialNumber, orderItem.id, tx, { staffId })

    // Calculate new totals
    const newSubtotal = Number(order.subtotal) + input.price
    const newTotal = newSubtotal - Number(order.discountAmount)

    // Update order totals and increment version
    const updatedOrder = await tx.order.update({
      where: { id: orderId },
      data: {
        subtotal: newSubtotal,
        total: newTotal,
        remainingBalance: newTotal,
        version: { increment: 1 },
      },
      include: {
        items: {
          include: {
            product: { select: { id: true, name: true, price: true } },
            modifiers: { include: { modifier: true } },
          },
        },
        payments: { include: { allocations: true } },
        table: { select: { id: true, number: true } },
        createdBy: { select: { id: true, firstName: true, lastName: true } },
        servedBy: { select: { id: true, firstName: true, lastName: true } },
      },
    })

    return updatedOrder
  })

  logger.info(`✅ [ORDER SERVICE] Added serialized item ${input.serialNumber} to order ${order.orderNumber}. New total: $${result.total}`)

  // Emit Socket.IO event for real-time updates
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastToVenue(venueId, SocketEventType.ORDER_UPDATED, {
      orderId: result.id,
      orderNumber: result.orderNumber,
      tableId: result.tableId,
      subtotal: Number(result.subtotal),
      total: Number(result.total),
      version: result.version,
    })
  }

  const tableName = result.table ? `Mesa ${result.table.number}` : null
  return { ...flattenOrderModifiers(result), tableName }
}

interface SellSerializedItemInput {
  serialNumber: string
  categoryId?: string // Required if item not registered
  price: number // Cashier-entered price
  paymentMethodId?: string // Optional: if paying immediately
  notes?: string | null
  terminalId?: string | null // Terminal that created this order (for sales attribution)
  isPortabilidad?: boolean // Portabilidad sale (number porting) — stored as order tag
}

/**
 * Quick sell a single serialized item (creates new order + item in one shot).
 * For fast checkout of serialized items without an existing order.
 *
 * @param venueId Venue ID
 * @param input Serialized item and payment details
 * @param staffId Staff ID performing the sale
 */
export async function sellSerializedItem(
  venueId: string,
  input: SellSerializedItemInput,
  staffId: string,
): Promise<Order & { tableName: string | null }> {
  logger.info(`💵 [ORDER SERVICE] Quick sell serialized item ${input.serialNumber}`)
  await assertVenueSalesEnabled(venueId)

  // Verify module is enabled for this venue
  const isEnabled = await moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY)
  if (!isEnabled) {
    throw new BadRequestError('Serialized inventory module is not enabled for this venue')
  }

  // Scan to check item status
  const scanResult = await serializedInventoryService.scan(venueId, input.serialNumber)

  if (scanResult.status === 'already_sold') {
    throw new BadRequestError(`Item ${input.serialNumber} ya fue vendido`)
  }

  if (scanResult.status === 'module_disabled') {
    throw new BadRequestError('Módulo de inventario serializado no habilitado')
  }

  // Generate order number
  const orderCount = await prisma.order.count({ where: { venueId } })
  const orderNumber = `SN${String(orderCount + 1).padStart(5, '0')}`

  // Use transaction for atomicity
  const result = await prisma.$transaction(async tx => {
    let serializedItemWithCategory: Awaited<ReturnType<typeof serializedInventoryService.getItemBySerialNumber>>

    if (scanResult.found && scanResult.item) {
      serializedItemWithCategory = scanResult.item
    } else {
      if (!input.categoryId) {
        throw new BadRequestError('categoryId is required for unregistered items')
      }

      // ENFORCE: prohibido vender SIMs no registradas on-the-fly. Deben pasar por
      // alta → aprobación → custodia (spec §3.3). Solo aplica a la rama de venta
      // de items NO registrados; los items ya registrados siguen vendiéndose normal.
      const sellVenue = await prisma.venue.findUnique({
        where: { id: venueId },
        select: { organizationId: true },
      })
      if (sellVenue?.organizationId && (await simRegistrationService.isApprovalModeEnabled(sellVenue.organizationId))) {
        throw new ValidationError('Esta SIM no está dada de alta. Debe aprobarse antes de venderse.')
      }

      serializedItemWithCategory = await serializedInventoryService.register({
        venueId,
        categoryId: input.categoryId,
        serialNumber: input.serialNumber,
        createdBy: staffId,
      })
    }

    // Build OrderItem data with proper snapshot fields
    const orderItemData = serializedInventoryService.buildOrderItemData(serializedItemWithCategory!, input.price)

    // Build tags from sale context
    const tags: string[] = []
    if (input.isPortabilidad) tags.push('portabilidad')

    // Create order (PENDING until payment)
    const order = await tx.order.create({
      data: {
        venueId,
        orderNumber,
        status: 'PENDING', // Will be COMPLETED when payment succeeds
        paymentStatus: 'PENDING',
        subtotal: input.price,
        taxAmount: 0, // No tax by default for serialized items
        total: input.price,
        remainingBalance: input.price,
        createdById: staffId,
        servedById: staffId,
        type: 'DINE_IN', // Default, could be parameterized
        // ⭐ Terminal that created this order (for sales attribution by device)
        terminalId: input.terminalId || null,
        // Tags for flexible categorization (e.g., portabilidad)
        tags,
        items: {
          create: {
            ...orderItemData, // Includes: productName, productSku, unitPrice, quantity, total, taxAmount, productId
            notes: input.notes,
          },
        },
      },
      include: {
        items: true,
      },
    })

    // ⚠️ DO NOT mark as SOLD here - only mark as SOLD when payment completes
    // Item will be marked as SOLD in processPayment() when payment succeeds
    // This prevents marking items as sold when payment is cancelled/fails

    // Fetch full order with all includes
    const fullOrder = await tx.order.findUniqueOrThrow({
      where: { id: order.id },
      include: {
        items: {
          include: {
            product: { select: { id: true, name: true, price: true } },
            modifiers: { include: { modifier: true } },
          },
        },
        payments: { include: { allocations: true } },
        table: { select: { id: true, number: true } },
        createdBy: { select: { id: true, firstName: true, lastName: true } },
        servedBy: { select: { id: true, firstName: true, lastName: true } },
      },
    })

    return fullOrder
  })

  logger.info(`✅ [ORDER SERVICE] Created order ${orderNumber} for serialized item ${input.serialNumber}. Total: $${input.price}`)

  // Emit Socket.IO event
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastToVenue(venueId, SocketEventType.ORDER_CREATED, {
      orderId: result.id,
      orderNumber: result.orderNumber,
      subtotal: Number(result.subtotal),
      total: Number(result.total),
      version: result.version,
    })
  }

  const tableName = result.table ? `Mesa ${result.table.number}` : null
  return { ...flattenOrderModifiers(result), tableName }
}
