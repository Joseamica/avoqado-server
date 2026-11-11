/**
 * Coupon Dashboard Service
 *
 * HTTP-agnostic business logic for coupon code management.
 * Controllers orchestrate HTTP, services contain logic.
 *
 * @see CLAUDE.md - Layered Architecture section
 * @see docs/CUSTOMER_DISCOUNT_IMPLEMENTATION_PLAN.md - Phase 2 specifications
 */

import prisma from '@/utils/prismaClient'
import { withDeadlockRetry } from '@/utils/serializableRetry'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import { CAMBIO_CRUZADO, dondeEscribir, esCambioCruzado, validarCambioDeDescuento } from './reglasDeDescuento'
import logger from '@/config/logger'
import { DiscountType, Prisma } from '@prisma/client'
import { logAction } from './activity-log.service'
import { bloquearCuentaParaEditar } from '../shared/cuentaCancelada'
import { ORDER_LOCK_WAIT_BUDGET } from '../shared/paymentShiftClaim'

// ==========================================
// TYPES & INTERFACES
// ==========================================

interface CouponCodeListItem {
  id: string
  code: string
  discountId: string
  discount: {
    id: string
    name: string
    type: DiscountType
    value: number
  }
  maxUses: number | null
  maxUsesPerCustomer: number | null
  currentUses: number
  minPurchaseAmount: number | null
  validFrom: Date | null
  validUntil: Date | null
  active: boolean
  createdAt: Date
  _count: {
    redemptions: number
  }
}

interface PaginatedCouponsResponse {
  data: CouponCodeListItem[]
  meta: {
    totalCount: number
    pageSize: number
    currentPage: number
    totalPages: number
    hasNextPage: boolean
    hasPrevPage: boolean
  }
}

interface CreateCouponCodeRequest {
  discountId: string
  code: string
  maxUses?: number
  maxUsesPerCustomer?: number
  minPurchaseAmount?: number
  validFrom?: Date
  validUntil?: Date
  active?: boolean
}

interface UpdateCouponCodeRequest {
  code?: string
  maxUses?: number | null
  maxUsesPerCustomer?: number | null
  minPurchaseAmount?: number | null
  validFrom?: Date | null
  validUntil?: Date | null
  active?: boolean
}

interface BulkGenerateCouponsRequest {
  discountId: string
  prefix?: string
  quantity: number
  codeLength?: number
  maxUsesPerCode?: number
  maxUsesPerCustomer?: number
  validFrom?: Date
  validUntil?: Date
}

export interface CouponValidationResult {
  valid: boolean
  coupon?: {
    id: string
    code: string
    discount: {
      id: string
      name: string
      type: DiscountType
      value: number
      scope: string
      maxDiscountAmount: number | null
      /** D2 (Codex D1 r3 #1): el cupón hereda la «aprobación de gerente» de su descuento. */
      requiresApproval?: boolean
    }
  }
  error?: string
  errorCode?: 'NOT_FOUND' | 'INACTIVE' | 'EXPIRED' | 'NOT_STARTED' | 'USAGE_LIMIT' | 'MIN_PURCHASE' | 'CUSTOMER_LIMIT'
  /** MIN_PURCHASE: la compra mínima; CUSTOMER_LIMIT: los usos por cliente. Para que quien muestre el rechazo arme su texto. */
  limite?: number
  /** Válido: la compra mínima que rige (la del código o la del descuento). Para revisarla otra vez cuando la base se conoce después. */
  minimo?: number | null
}

interface _CouponRedemptionItem {
  id: string
  couponCodeId: string
  customerId: string | null
  customer: {
    id: string
    firstName: string | null
    lastName: string | null
    email: string | null
  } | null
  orderId: string
  amountSaved: number
  redeemedAt: Date
}

// ==========================================
// COUPON CRUD OPERATIONS
// ==========================================

/**
 * Get all coupon codes for a venue with pagination
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param page - Page number (1-indexed)
 * @param pageSize - Items per page
 * @param search - Search term (code)
 * @param discountId - Filter by discount
 * @param active - Filter by active status
 */
export async function getCouponCodes(
  venueId: string,
  page: number = 1,
  pageSize: number = 20,
  search?: string,
  discountId?: string,
  active?: boolean,
): Promise<PaginatedCouponsResponse> {
  const skip = (page - 1) * pageSize

  // Build where clause - filter through discount's venueId
  const where: Prisma.CouponCodeWhereInput = {
    discount: { venueId },
    ...(search && {
      code: { contains: search.toUpperCase(), mode: 'insensitive' as const },
    }),
    ...(discountId && { discountId }),
    ...(active !== undefined && { active }),
  }

  // Execute count and fetch in parallel
  const [totalCount, coupons] = await Promise.all([
    prisma.couponCode.count({ where }),
    prisma.couponCode.findMany({
      where,
      skip,
      take: pageSize,
      orderBy: { createdAt: 'desc' },
      include: {
        discount: {
          select: {
            id: true,
            name: true,
            type: true,
            value: true,
          },
        },
        _count: {
          select: {
            redemptions: true,
          },
        },
      },
    }),
  ])

  const totalPages = Math.ceil(totalCount / pageSize)

  return {
    data: coupons.map(c => ({
      ...c,
      discount: {
        ...c.discount,
        value: Number(c.discount.value),
      },
      minPurchaseAmount: c.minPurchaseAmount ? Number(c.minPurchaseAmount) : null,
    })) as unknown as CouponCodeListItem[],
    meta: {
      totalCount,
      pageSize,
      currentPage: page,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    },
  }
}

/**
 * Get a single coupon code by ID
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param couponId - Coupon ID
 * @throws NotFoundError if coupon not found
 */
export async function getCouponCodeById(venueId: string, couponId: string) {
  const coupon = await prisma.couponCode.findFirst({
    where: {
      id: couponId,
      discount: { venueId },
    },
    include: {
      discount: {
        select: {
          id: true,
          name: true,
          description: true,
          type: true,
          value: true,
          scope: true,
          maxDiscountAmount: true,
          active: true,
        },
      },
      redemptions: {
        include: {
          customer: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
            },
          },
          order: {
            select: {
              id: true,
              total: true,
              createdAt: true,
            },
          },
        },
        orderBy: { redeemedAt: 'desc' },
        take: 20,
      },
      _count: {
        select: {
          redemptions: true,
        },
      },
    },
  })

  if (!coupon) {
    throw new NotFoundError('El cupón no existe')
  }

  return {
    ...coupon,
    discount: {
      ...coupon.discount,
      value: Number(coupon.discount.value),
      maxDiscountAmount: coupon.discount.maxDiscountAmount ? Number(coupon.discount.maxDiscountAmount) : null,
    },
    minPurchaseAmount: coupon.minPurchaseAmount ? Number(coupon.minPurchaseAmount) : null,
    redemptions: coupon.redemptions.map(r => ({
      ...r,
      amountSaved: Number(r.amountSaved),
      order: r.order
        ? {
            ...r.order,
            total: Number(r.order.total),
          }
        : null,
    })),
  }
}

/**
 * Create a new coupon code
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param data - Coupon data
 */
export async function createCouponCode(venueId: string, data: CreateCouponCodeRequest) {
  // Verify discount exists and belongs to venue
  const discount = await prisma.discount.findFirst({
    where: { id: data.discountId, venueId },
  })
  if (!discount) {
    throw new NotFoundError('El descuento no existe')
  }
  const invalido = validarCambioDeDescuento(null, { maxUses: data.maxUses, maxUsesPerCustomer: data.maxUsesPerCustomer })
  if (invalido) throw new BadRequestError(invalido)

  // Normalize code to uppercase
  const normalizedCode = data.code.toUpperCase().trim()

  // Check if code already exists (globally unique)
  const existingCode = await prisma.couponCode.findUnique({
    where: { code: normalizedCode },
  })
  if (existingCode) {
    throw new BadRequestError(`Ya existe un cupón con el código "${normalizedCode}"`)
  }

  // Validate code format
  if (!/^[A-Z0-9-_]+$/.test(normalizedCode)) {
    throw new BadRequestError('El código sólo puede tener letras, números, guiones y guiones bajos')
  }

  if (normalizedCode.length < 3 || normalizedCode.length > 30) {
    throw new BadRequestError('El código debe tener entre 3 y 30 caracteres')
  }

  const coupon = await withDeadlockRetry(
    tx =>
      tx.couponCode.create({
        data: {
          discountId: data.discountId,
          code: normalizedCode,
          maxUses: data.maxUses,
          maxUsesPerCustomer: data.maxUsesPerCustomer,
          minPurchaseAmount: data.minPurchaseAmount,
          validFrom: data.validFrom,
          validUntil: data.validUntil,
          active: data.active ?? true,
        },
        include: {
          discount: {
            select: {
              id: true,
              name: true,
              type: true,
              value: true,
            },
          },
        },
      }),
    { etiqueta: 'createCouponCode' },
  )

  logger.info(`🎫 Coupon code created: ${normalizedCode} for discount ${discount.name}`)

  logAction({
    venueId,
    action: 'COUPON_CREATED',
    entity: 'Coupon',
    entityId: coupon.id,
    data: { code: coupon.code },
  })

  return {
    ...coupon,
    discount: {
      ...coupon.discount,
      value: Number(coupon.discount.value),
    },
    minPurchaseAmount: coupon.minPurchaseAmount ? Number(coupon.minPurchaseAmount) : null,
  }
}

/**
 * Update an existing coupon code
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param couponId - Coupon ID
 * @param data - Update data
 * @throws NotFoundError if coupon not found
 */
export async function updateCouponCode(venueId: string, couponId: string, data: UpdateCouponCodeRequest) {
  // Check coupon exists and belongs to venue
  const existing = await prisma.couponCode.findFirst({
    where: { id: couponId, discount: { venueId } },
  })
  if (!existing) {
    throw new NotFoundError('El cupón no existe')
  }
  const cambio = { maxUses: data.maxUses, maxUsesPerCustomer: data.maxUsesPerCustomer }
  const invalido = validarCambioDeDescuento(existing, cambio)
  if (invalido) throw new BadRequestError(invalido)

  // If updating code, normalize and check uniqueness
  let normalizedCode: string | undefined
  if (data.code !== undefined) {
    normalizedCode = data.code.toUpperCase().trim()

    // Validate code format
    if (!/^[A-Z0-9-_]+$/.test(normalizedCode)) {
      throw new BadRequestError('El código sólo puede tener letras, números, guiones y guiones bajos')
    }

    if (normalizedCode.length < 3 || normalizedCode.length > 30) {
      throw new BadRequestError('El código debe tener entre 3 y 30 caracteres')
    }

    // Check uniqueness if code is different
    if (normalizedCode !== existing.code) {
      const existingCode = await prisma.couponCode.findUnique({
        where: { code: normalizedCode },
      })
      if (existingCode) {
        throw new BadRequestError(`Ya existe un cupón con el código "${normalizedCode}"`)
      }
    }
  }

  const coupon = await withDeadlockRetry(
    tx =>
      tx.couponCode.update({
        where: dondeEscribir(couponId, existing, cambio),
        data: {
          ...(normalizedCode !== undefined && { code: normalizedCode }),
          ...(data.maxUses !== undefined && { maxUses: data.maxUses }),
          ...(data.maxUsesPerCustomer !== undefined && { maxUsesPerCustomer: data.maxUsesPerCustomer }),
          ...(data.minPurchaseAmount !== undefined && { minPurchaseAmount: data.minPurchaseAmount }),
          ...(data.validFrom !== undefined && { validFrom: data.validFrom }),
          ...(data.validUntil !== undefined && { validUntil: data.validUntil }),
          ...(data.active !== undefined && { active: data.active }),
        },
        include: {
          discount: {
            select: {
              id: true,
              name: true,
              type: true,
              value: true,
            },
          },
        },
      }),
    { etiqueta: 'updateCouponCode' },
  ).catch(error => {
    throw esCambioCruzado(error) ? new ConflictError(CAMBIO_CRUZADO) : error
  })

  logger.info(`🎫 Coupon code updated: ${coupon.code}`)

  logAction({
    venueId,
    action: 'COUPON_UPDATED',
    entity: 'Coupon',
    entityId: coupon.id,
    data: { code: coupon.code },
  })

  return {
    ...coupon,
    discount: {
      ...coupon.discount,
      value: Number(coupon.discount.value),
    },
    minPurchaseAmount: coupon.minPurchaseAmount ? Number(coupon.minPurchaseAmount) : null,
  }
}

/**
 * Delete a coupon code
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param couponId - Coupon ID
 * @throws NotFoundError if coupon not found
 */
export async function deleteCouponCode(venueId: string, couponId: string): Promise<void> {
  const existing = await prisma.couponCode.findFirst({
    where: { id: couponId, discount: { venueId } },
  })
  if (!existing) {
    throw new NotFoundError('El cupón no existe')
  }

  await withDeadlockRetry(
    tx =>
      tx.couponCode.delete({
        where: { id: couponId },
      }),
    { etiqueta: 'deleteCouponCode' },
  )

  logger.info(`🗑️ Coupon code deleted: ${existing.code} (${couponId})`)

  logAction({
    venueId,
    action: 'COUPON_DELETED',
    entity: 'Coupon',
    entityId: couponId,
    data: { code: existing.code },
  })
}

// ==========================================
// BULK OPERATIONS
// ==========================================

/**
 * Generate random alphanumeric code
 */
function generateRandomCode(length: number): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // Exclude confusing chars (0, O, 1, I)
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

/**
 * Bulk generate coupon codes
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param data - Bulk generation parameters
 */
export async function bulkGenerateCouponCodes(venueId: string, data: BulkGenerateCouponsRequest) {
  // Verify discount exists and belongs to venue
  const discount = await prisma.discount.findFirst({
    where: { id: data.discountId, venueId },
  })
  if (!discount) {
    throw new NotFoundError('El descuento no existe')
  }
  const invalido = validarCambioDeDescuento(null, { maxUses: data.maxUsesPerCode, maxUsesPerCustomer: data.maxUsesPerCustomer })
  if (invalido) throw new BadRequestError(invalido)

  if (data.quantity < 1 || data.quantity > 1000) {
    throw new BadRequestError('La cantidad debe estar entre 1 y 1000')
  }

  const codeLength = data.codeLength ?? 8
  if (codeLength < 4 || codeLength > 20) {
    throw new BadRequestError('El largo del código debe estar entre 4 y 20')
  }

  const prefix = data.prefix?.toUpperCase().trim() ?? ''

  // Generate unique codes
  const codes: string[] = []
  const maxAttempts = data.quantity * 10 // Allow retries for collisions

  for (let attempt = 0; attempt < maxAttempts && codes.length < data.quantity; attempt++) {
    const randomPart = generateRandomCode(codeLength)
    const code = prefix ? `${prefix}-${randomPart}` : randomPart

    // Check uniqueness (both locally and in DB)
    if (!codes.includes(code)) {
      const exists = await prisma.couponCode.findUnique({ where: { code } })
      if (!exists) {
        codes.push(code)
      }
    }
  }

  if (codes.length < data.quantity) {
    throw new BadRequestError(`Sólo se pudieron generar ${codes.length} códigos únicos. Prueba con códigos más largos.`)
  }

  // Bulk create
  const coupons = await withDeadlockRetry(
    tx =>
      tx.couponCode.createMany({
        data: codes.map(code => ({
          discountId: data.discountId,
          code,
          maxUses: data.maxUsesPerCode,
          maxUsesPerCustomer: data.maxUsesPerCustomer,
          validFrom: data.validFrom,
          validUntil: data.validUntil,
          active: true,
        })),
      }),
    { etiqueta: 'bulkGenerateCouponCodes' },
  )

  logger.info(`🎫 Bulk generated ${coupons.count} coupon codes for discount ${discount.name}`)

  logAction({
    venueId,
    action: 'COUPONS_BULK_GENERATED',
    entity: 'Coupon',
    entityId: data.discountId,
    data: { count: coupons.count },
  })

  return {
    count: coupons.count,
    codes,
    discountId: data.discountId,
  }
}

// ==========================================
// COUPON VALIDATION
// ==========================================

/**
 * Validate a coupon code for use
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param code - Coupon code to validate
 * @param orderTotal - Order total (for min purchase check)
 * @param customerId - Customer ID (for per-customer limit check)
 * @param db - Previews use the global client; the TPV apply passes its Order-locked transaction
 */
export async function validateCouponCode(
  venueId: string,
  code: string,
  orderTotal?: number,
  customerId?: string,
  db: Prisma.TransactionClient = prisma,
): Promise<CouponValidationResult> {
  const normalizedCode = code.toUpperCase().trim()

  // Find the coupon
  const coupon = await db.couponCode.findFirst({
    where: {
      code: normalizedCode,
      discount: { venueId },
    },
    include: {
      discount: {
        select: {
          id: true,
          name: true,
          type: true,
          value: true,
          scope: true,
          maxDiscountAmount: true,
          active: true,
          requiresApproval: true,
          // D5: lo que el cupón hereda del descuento si no trae lo suyo (el esquema: sus campos «override»).
          validFrom: true,
          validUntil: true,
          maxTotalUses: true,
          currentUses: true,
          minPurchaseAmount: true,
          maxUsesPerCustomer: true,
        },
      },
      _count: {
        select: {
          redemptions: true,
        },
      },
    },
  })

  if (!coupon) {
    return {
      valid: false,
      error: 'Coupon code not found',
      errorCode: 'NOT_FOUND',
    }
  }

  // Check if coupon is active
  if (!coupon.active) {
    return {
      valid: false,
      error: 'Coupon code is inactive',
      errorCode: 'INACTIVE',
    }
  }

  // Check if parent discount is active
  if (!coupon.discount.active) {
    return {
      valid: false,
      error: 'Discount associated with this coupon is inactive',
      errorCode: 'INACTIVE',
    }
  }

  const now = new Date()

  // Check validity period
  const validFrom = coupon.validFrom ?? coupon.discount.validFrom
  if (validFrom && validFrom > now) {
    return {
      valid: false,
      error: `Coupon is not valid yet. Valid from ${validFrom.toISOString()}`,
      errorCode: 'NOT_STARTED',
    }
  }

  const validUntil = coupon.validUntil ?? coupon.discount.validUntil
  if (validUntil && validUntil < now) {
    return {
      valid: false,
      error: 'Coupon has expired',
      errorCode: 'EXPIRED',
    }
  }

  // Check usage limit (el del código y el total del descuento)
  if (
    (coupon.maxUses != null && coupon.currentUses >= coupon.maxUses) ||
    (coupon.discount.maxTotalUses != null && coupon.discount.currentUses >= coupon.discount.maxTotalUses)
  ) {
    return {
      valid: false,
      error: 'Coupon usage limit has been reached',
      errorCode: 'USAGE_LIMIT',
    }
  }

  // Check minimum purchase amount
  const minPurchase = coupon.minPurchaseAmount ?? coupon.discount.minPurchaseAmount
  if (minPurchase != null && orderTotal !== undefined) {
    if (orderTotal < Number(minPurchase)) {
      return {
        valid: false,
        error: `Minimum purchase of ${Number(minPurchase)} required`,
        errorCode: 'MIN_PURCHASE',
        limite: Number(minPurchase),
      }
    }
  }

  // Check per-customer usage limit: el del código o, si no trae, el del descuento (sus usos con cualquier código suyo).
  const porCliente = coupon.maxUsesPerCustomer ?? coupon.discount.maxUsesPerCustomer
  if (porCliente != null && customerId) {
    const customerRedemptions = await db.couponRedemption.count({
      where:
        coupon.maxUsesPerCustomer != null
          ? { couponCodeId: coupon.id, customerId }
          : { couponCode: { discountId: coupon.discount.id }, customerId },
    })

    if (customerRedemptions >= porCliente) {
      return {
        valid: false,
        error: `You have already used this coupon ${porCliente} time(s)`,
        errorCode: 'CUSTOMER_LIMIT',
        limite: porCliente,
      }
    }
  }

  return {
    valid: true,
    minimo: minPurchase != null ? Number(minPurchase) : null,
    coupon: {
      id: coupon.id,
      code: coupon.code,
      discount: {
        id: coupon.discount.id,
        name: coupon.discount.name,
        type: coupon.discount.type,
        value: Number(coupon.discount.value),
        scope: coupon.discount.scope,
        maxDiscountAmount: coupon.discount.maxDiscountAmount ? Number(coupon.discount.maxDiscountAmount) : null,
        requiresApproval: coupon.discount.requiresApproval,
      },
    },
  }
}

// ==========================================
// COUPON REDEMPTION
// ==========================================

/**
 * Record a coupon redemption
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param couponId - Coupon code ID
 * @param orderId - Order ID
 * @param amountSaved - Amount saved by the coupon
 * @param customerId - Customer ID (optional)
 */
export async function recordCouponRedemption(venueId: string, couponId: string, orderId: string, amountSaved: number, customerId?: string) {
  // Verify coupon exists and belongs to venue
  const coupon = await prisma.couponCode.findFirst({
    where: { id: couponId, discount: { venueId } },
    include: { discount: true },
  })
  if (!coupon) {
    throw new NotFoundError('El cupón no existe')
  }

  // Create redemption and increment usage counter in transaction
  const result = await withDeadlockRetry(
    async tx => {
      // No escribe importes ni Order: el modo débil excluye cambios de estado sin bloquear las FK de métricas.
      if (!(await bloquearCuentaParaEditar(tx, { venueId, orderId }, 'ATRIBUCION'))) throw new NotFoundError('Order not found')
      const existingRedemption = await tx.couponRedemption.findUnique({ where: { orderId } })
      if (existingRedemption) throw new BadRequestError('This order already has a coupon redemption')
      // AJENO S11 (E12): la clienta del canje es de ESTA sucursal. La llave foránea sólo mira el id: sin esto se ligaba (y se devolvía
      // con su nombre) una clienta de otra sucursal. Sigue opcional.
      if (customerId && !(await tx.customer.findFirst({ where: { id: customerId, venueId }, select: { id: true } }))) {
        throw new NotFoundError('Cliente no encontrado')
      }

      // Create redemption record
      const redemption = await tx.couponRedemption.create({
        data: {
          couponCodeId: couponId,
          orderId,
          customerId,
          amountSaved,
          redeemedAt: new Date(),
        },
        include: {
          couponCode: {
            select: {
              id: true,
              code: true,
            },
          },
          customer: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      })

      // Increment usage counter
      await tx.couponCode.update({
        where: { id: couponId },
        data: { currentUses: { increment: 1 } },
      })

      // Also increment the parent discount's usage counter
      await tx.discount.update({
        where: { id: coupon.discountId },
        data: { currentUses: { increment: 1 } },
      })

      return redemption
    },
    { etiqueta: 'recordCouponRedemption', ...ORDER_LOCK_WAIT_BUDGET },
  )

  logger.info(`🎫 Coupon redeemed: ${coupon.code} on order ${orderId}, saved ${amountSaved}`)

  return {
    ...result,
    amountSaved: Number(result.amountSaved),
  }
}

/**
 * Get coupon redemption history for a venue
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param page - Page number
 * @param pageSize - Items per page
 * @param couponId - Filter by specific coupon
 * @param customerId - Filter by customer
 */
export async function getCouponRedemptions(
  venueId: string,
  page: number = 1,
  pageSize: number = 20,
  couponId?: string,
  customerId?: string,
) {
  const skip = (page - 1) * pageSize

  const where: Prisma.CouponRedemptionWhereInput = {
    couponCode: { discount: { venueId } },
    ...(couponId && { couponCodeId: couponId }),
    ...(customerId && { customerId }),
  }

  const [totalCount, redemptions] = await Promise.all([
    prisma.couponRedemption.count({ where }),
    prisma.couponRedemption.findMany({
      where,
      skip,
      take: pageSize,
      orderBy: { redeemedAt: 'desc' },
      include: {
        couponCode: {
          select: {
            id: true,
            code: true,
            discount: {
              select: {
                id: true,
                name: true,
                type: true,
              },
            },
          },
        },
        customer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        order: {
          select: {
            id: true,
            total: true,
            createdAt: true,
          },
        },
      },
    }),
  ])

  const totalPages = Math.ceil(totalCount / pageSize)

  return {
    data: redemptions.map(r => ({
      ...r,
      amountSaved: Number(r.amountSaved),
      order: r.order
        ? {
            ...r.order,
            total: Number(r.order.total),
          }
        : null,
    })),
    meta: {
      totalCount,
      pageSize,
      currentPage: page,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    },
  }
}

// ==========================================
// COUPON STATISTICS
// ==========================================

/**
 * Get coupon statistics for a venue
 *
 * @param venueId - Venue ID (multi-tenant filter)
 */
export async function getCouponStats(venueId: string) {
  const [totalCoupons, activeCoupons, redemptions] = await Promise.all([
    prisma.couponCode.count({ where: { discount: { venueId } } }),
    prisma.couponCode.count({ where: { discount: { venueId }, active: true } }),
    prisma.couponRedemption.findMany({
      where: { couponCode: { discount: { venueId } } },
      select: {
        amountSaved: true,
        couponCodeId: true,
      },
    }),
  ])

  const totalRedemptions = redemptions.length
  const totalSaved = redemptions.reduce((sum, r) => sum + Number(r.amountSaved), 0)

  // Count redemptions per coupon
  const couponUsage = new Map<string, number>()
  for (const r of redemptions) {
    couponUsage.set(r.couponCodeId, (couponUsage.get(r.couponCodeId) ?? 0) + 1)
  }

  // Get top performing coupons
  const topCoupons = await prisma.couponCode.findMany({
    where: {
      discount: { venueId },
      id: { in: Array.from(couponUsage.keys()) },
    },
    select: {
      id: true,
      code: true,
      currentUses: true,
      discount: {
        select: {
          name: true,
        },
      },
    },
    orderBy: { currentUses: 'desc' },
    take: 5,
  })

  return {
    totalCoupons,
    activeCoupons,
    totalRedemptions,
    totalSaved,
    averageSavings: totalRedemptions > 0 ? totalSaved / totalRedemptions : 0,
    topCoupons: topCoupons.map(c => ({
      id: c.id,
      code: c.code,
      discountName: c.discount.name,
      redemptions: c.currentUses,
    })),
  }
}
