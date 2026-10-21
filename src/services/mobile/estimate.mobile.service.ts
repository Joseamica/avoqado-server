/**
 * Mobile Estimate Service
 *
 * Estimate (Presupuesto) management for iOS/Android POS apps.
 * Handles creation, status updates, and conversion to orders.
 */

import { Prisma } from '@prisma/client'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import { logAction } from '../dashboard/activity-log.service'
import prisma from '../../utils/prismaClient'
import { Decimal } from '@prisma/client/runtime/library'
import { assertVenueSalesEnabled } from '../venueSalesGuard'
import { turnoAbiertoDelNegocio } from '../shared/turnoDeCaja'

// ============================================================================
// TYPES
// ============================================================================

export interface ListEstimateFilters {
  status?: string
  dateFrom?: string
  dateTo?: string
  search?: string
}

interface CreateEstimateItem {
  productId?: string
  productName: string
  quantity: number
  unitPrice: number // pesos, tal como se tecleó (IVA incluido)
}

interface CreateEstimateParams {
  venueId: string
  staffId: string
  staffName: string
  customerId?: string
  customerName?: string
  customerEmail?: string
  customerPhone?: string
  items: CreateEstimateItem[]
  notes?: string
  validUntil?: string
}

// ============================================================================
// LIST ESTIMATES
// ============================================================================

/**
 * List estimates for a venue with optional filters.
 */
export async function listEstimates(venueId: string, page: number, pageSize: number, filters?: ListEstimateFilters) {
  const skip = (page - 1) * pageSize
  const where: any = { venueId }

  if (filters?.status) {
    const statuses = filters.status.split(',').map(s => s.trim())
    where.status = { in: statuses }
  }

  if (filters?.dateFrom || filters?.dateTo) {
    where.createdAt = {}
    if (filters?.dateFrom) where.createdAt.gte = new Date(filters.dateFrom)
    if (filters?.dateTo) where.createdAt.lte = new Date(filters.dateTo + 'T23:59:59.999Z')
  }

  if (filters?.search) {
    const term = filters.search.trim()
    where.OR = [
      { estimateNumber: { contains: term, mode: 'insensitive' } },
      { customerName: { contains: term, mode: 'insensitive' } },
      { customerEmail: { contains: term, mode: 'insensitive' } },
      { notes: { contains: term, mode: 'insensitive' } },
    ]
  }

  const [estimates, total] = await Promise.all([
    prisma.estimate.findMany({
      where,
      include: {
        items: true,
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: pageSize,
    }),
    prisma.estimate.count({ where }),
  ])

  return {
    estimates: estimates.map(formatEstimate),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  }
}

// ============================================================================
// GET ESTIMATE DETAIL
// ============================================================================

/**
 * Get a single estimate with full details.
 */
export async function getEstimate(estimateId: string, venueId: string) {
  const estimate = await prisma.estimate.findFirst({
    where: { id: estimateId, venueId },
    include: {
      items: true,
    },
  })

  if (!estimate) {
    throw new NotFoundError('Presupuesto no encontrado')
  }

  return formatEstimate(estimate)
}

// ============================================================================
// CREATE ESTIMATE
// ============================================================================

/**
 * Generate a sequential estimate number: EST-{YYYYMMDD}-{sequence}
 */
async function generateEstimateNumber(venueId: string): Promise<string> {
  const today = new Date()
  const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '')
  const prefix = `EST-${dateStr}-`

  // Find the highest sequence number for today
  const lastEstimate = await prisma.estimate.findFirst({
    where: {
      venueId,
      estimateNumber: { startsWith: prefix },
    },
    orderBy: { estimateNumber: 'desc' },
    select: { estimateNumber: true },
  })

  let sequence = 1
  if (lastEstimate) {
    const lastSeq = parseInt(lastEstimate.estimateNumber.replace(prefix, ''), 10)
    if (!isNaN(lastSeq)) {
      sequence = lastSeq + 1
    }
  }

  return `${prefix}${sequence.toString().padStart(3, '0')}`
}

/**
 * Create a new estimate.
 */
export async function createEstimate(params: CreateEstimateParams) {
  const { venueId, staffId, staffName, items, notes, validUntil } = params

  if (!items || items.length === 0) {
    throw new BadRequestError('Se requiere al menos un producto')
  }

  if (!staffName || !staffName.trim()) {
    throw new BadRequestError('staffName es requerido')
  }

  // Generate estimate number
  const estimateNumber = await generateEstimateNumber(venueId)

  // Normalize items: accept both {productName, quantity, unitPrice} and {name, qty, price}
  const normalizedItems = items.map((item: any) => ({
    productId: item.productId || null,
    productName: item.productName || item.name || 'Producto',
    quantity: item.quantity ?? item.qty ?? 1,
    unitPrice: item.unitPrice ?? item.price ?? 0,
  }))

  // 🔴 PESOS 1:1, como todo el API: las dos apps mandan el precio tal como se tecleó junto al «$». Antes se dividía
  // entre 100 («centavos») y la respuesta multiplicaba por 100: la pantalla decía $100 y la base guardaba $1.
  let subtotal = new Decimal(0)
  const itemsData = normalizedItems.map(item => {
    const unitPrice = new Decimal(item.unitPrice).toDecimalPlaces(2)
    const totalPrice = unitPrice.mul(item.quantity).toDecimalPlaces(2)
    subtotal = subtotal.add(totalPrice)

    return {
      productId: item.productId || null,
      productName: item.productName,
      quantity: item.quantity,
      unitPrice,
      totalPrice,
    }
  })

  // 🔴 El precio YA trae el IVA (convención mexicana, igual que toda venta nativa): el total es la suma de los precios y
  // `taxAmount` queda en 0 — el desglose lo arma el CFDI con el tratamiento de cada producto. Antes se sumaba el 16 %
  // ENCIMA (`total = subtotal × 1.16`, el «$100 + tax» de EE.UU.) y la orden convertida le cobraba eso al cliente.
  const taxAmount = new Decimal(0)
  const total = subtotal

  const estimate = await prisma.estimate.create({
    data: {
      venueId,
      estimateNumber,
      customerId: params.customerId || null,
      customerName: params.customerName || '',
      customerEmail: params.customerEmail || null,
      customerPhone: params.customerPhone || null,
      status: 'DRAFT',
      subtotal,
      taxAmount,
      total,
      notes: notes || null,
      validUntil: validUntil ? new Date(validUntil) : null,
      createdById: staffId,
      createdByName: staffName.trim(),
      items: {
        create: itemsData,
      },
    },
    include: {
      items: true,
    },
  })

  logAction({
    staffId,
    venueId,
    action: 'ESTIMATE_CREATED',
    entity: 'Estimate',
    entityId: estimate.id,
    data: { estimateNumber, itemCount: items.length, total: total.toNumber(), source: 'MOBILE' },
  })

  return formatEstimate(estimate)
}

// ============================================================================
// UPDATE STATUS
// ============================================================================

const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['SENT', 'CANCELLED'],
  SENT: ['ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED'],
  ACCEPTED: ['CONVERTED', 'CANCELLED'],
  REJECTED: ['DRAFT', 'CANCELLED'],
  EXPIRED: ['DRAFT', 'CANCELLED'],
}

/**
 * Update the status of an estimate.
 */
export async function updateStatus(estimateId: string, venueId: string, newStatus: string, staffId: string) {
  const estimate = await prisma.estimate.findFirst({
    where: { id: estimateId, venueId },
  })

  if (!estimate) {
    throw new NotFoundError('Presupuesto no encontrado')
  }

  const allowed = VALID_TRANSITIONS[estimate.status] || []
  if (!allowed.includes(newStatus)) {
    throw new BadRequestError(`No se puede cambiar de ${estimate.status} a ${newStatus}`)
  }

  const updateData: any = { status: newStatus }

  if (newStatus === 'SENT') {
    updateData.sentAt = new Date()
  } else if (newStatus === 'ACCEPTED') {
    updateData.acceptedAt = new Date()
  }

  const updated = await prisma.estimate.update({
    where: { id: estimateId },
    data: updateData,
    include: {
      items: true,
    },
  })

  logAction({
    staffId,
    venueId,
    action: 'ESTIMATE_STATUS_UPDATED',
    entity: 'Estimate',
    entityId: estimate.id,
    data: { from: estimate.status, to: newStatus, source: 'MOBILE' },
  })

  return formatEstimate(updated)
}

// ============================================================================
// CONVERT TO ORDER
// ============================================================================

/**
 * Convert an accepted estimate into an order.
 * Creates an Order with OrderItems from the estimate items.
 */
export async function convertToOrder(estimateId: string, venueId: string, staffId: string) {
  const estimate = await prisma.estimate.findFirst({
    where: { id: estimateId, venueId },
    include: {
      items: true,
    },
  })

  if (!estimate) {
    throw new NotFoundError('Presupuesto no encontrado')
  }

  if (estimate.status !== 'ACCEPTED') {
    throw new BadRequestError(`Solo se pueden convertir presupuestos aceptados. Estado actual: ${estimate.status}`)
  }

  if (estimate.convertedOrderId) {
    throw new BadRequestError('Este presupuesto ya fue convertido a orden')
  }

  await assertVenueSalesEnabled(venueId)

  // Create order from estimate
  const orderNumber = `ORD-${Date.now()}`

  // 🔴 Convertir el presupuesto lo hace una persona en el mostrador AHORA: la orden nace en el
  // turno abierto de ese momento (`../shared/turnoDeCaja.ts`). La FECHA del presupuesto no manda
  // — lo que nace hoy es la orden. Opcional: sin turno abierto la conversión ocurre igual.
  const currentShift = await turnoAbiertoDelNegocio(prisma, venueId)

  const order = await prisma.order.create({
    data: {
      venueId,
      shiftId: currentShift?.id ?? null,
      orderNumber,
      createdById: staffId,
      status: 'PENDING',
      paymentStatus: 'PENDING',
      kitchenStatus: 'PENDING',
      type: 'TAKEOUT',
      source: 'AVOQADO_IOS',
      // La orden cobra la suma de los precios con el IVA dentro (abajo: `taxAmount` 0, `total` = subtotal), aun si el
      // presupuesto viejo guardó el 16 % sumado encima: es IVA incluido, como el mostrador
      // (ver `services/fiscal/contratoDePrecio.ts`).
      contratoDePrecio: 'IVA_INCLUIDO',
      subtotal: estimate.subtotal,
      discountAmount: new Prisma.Decimal(0),
      // IVA incluido: la orden debe la suma de sus renglones y guarda `taxAmount` 0, como toda venta nativa. Nunca el
      // `total` guardado del presupuesto, que en los creados antes del 28-sep-2026 traía el 16 % sumado encima.
      taxAmount: new Prisma.Decimal(0),
      total: estimate.subtotal,
      remainingBalance: estimate.subtotal,
      customerName: estimate.customerName || null,
      version: 1,
      items: {
        create: estimate.items.map((item, index) => ({
          productId: item.productId || null,
          productName: item.productName,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          discountAmount: new Prisma.Decimal(0),
          taxAmount: new Prisma.Decimal(0),
          total: item.totalPrice,
          sequence: index,
        })),
      },
    },
    include: {
      items: true,
    },
  })

  // Update estimate status to CONVERTED
  await prisma.estimate.update({
    where: { id: estimateId },
    data: {
      status: 'CONVERTED',
      convertedOrderId: order.id,
    },
  })

  logAction({
    staffId,
    venueId,
    action: 'ESTIMATE_CONVERTED',
    entity: 'Estimate',
    entityId: estimate.id,
    data: {
      estimateNumber: estimate.estimateNumber,
      orderId: order.id,
      orderNumber,
      source: 'MOBILE',
    },
  })

  return {
    estimate: formatEstimate({
      ...estimate,
      status: 'CONVERTED',
      convertedOrderId: order.id,
    }),
    order: {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      paymentStatus: order.paymentStatus,
      subtotal: Number(order.subtotal),
      taxAmount: Number(order.taxAmount),
      total: Number(order.total),
      items: order.items.map(item => ({
        id: item.id,
        productId: item.productId,
        productName: item.productName,
        quantity: item.quantity,
        unitPrice: Number(item.unitPrice),
        total: Number(item.total),
      })),
      createdAt: order.createdAt.toISOString(),
    },
  }
}

// ============================================================================
// HELPERS
// ============================================================================

function formatEstimate(estimate: any) {
  return {
    id: estimate.id,
    venueId: estimate.venueId,
    estimateNumber: estimate.estimateNumber,
    // Android lee `number` (iOS, `estimateNumber`): los dos nombres, sin quitar ninguno.
    number: estimate.estimateNumber,
    status: estimate.status,
    customerId: estimate.customerId,
    customerName: estimate.customerName,
    customerEmail: estimate.customerEmail,
    customerPhone: estimate.customerPhone,
    // Pesos 1:1, como todo el API (antes ×100, y las apps lo mostraban como pesos).
    subtotal: Number(estimate.subtotal),
    taxAmount: Number(estimate.taxAmount),
    total: Number(estimate.total),
    notes: estimate.notes,
    validUntil: estimate.validUntil ? estimate.validUntil.toISOString() : null,
    sentAt: estimate.sentAt ? estimate.sentAt.toISOString() : null,
    acceptedAt: estimate.acceptedAt ? estimate.acceptedAt.toISOString() : null,
    convertedOrderId: estimate.convertedOrderId,
    createdById: estimate.createdById,
    createdByName: estimate.createdByName,
    items: estimate.items
      ? estimate.items.map((item: any) => ({
          id: item.id,
          productId: item.productId,
          productName: item.productName,
          quantity: item.quantity,
          unitPrice: Number(item.unitPrice),
          totalPrice: Number(item.totalPrice),
          // Android lee `total` (iOS, `totalPrice`).
          total: Number(item.totalPrice),
        }))
      : [],
    createdAt: estimate.createdAt.toISOString(),
    updatedAt: estimate.updatedAt.toISOString(),
  }
}
