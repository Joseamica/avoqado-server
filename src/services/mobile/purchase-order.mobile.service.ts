/**
 * Mobile Purchase Order Service
 *
 * Purchase order management for iOS/Android POS apps.
 * Handles creation, status updates, and stock receiving.
 */

import prisma from '../../utils/prismaClient'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import { logAction } from '../dashboard/activity-log.service'
import { applyItemReceiveStatusInTx } from '../dashboard/purchaseOrder.service'
import type { UpdatePurchaseOrderItemStatusDto } from '../../schemas/dashboard/inventory.schema'
import { PurchaseOrderItemStatus, PurchaseOrderStatus } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'

// ============================================================================
// LIST PURCHASE ORDERS
// ============================================================================

export interface ListPOFilters {
  status?: string
  dateFrom?: string
  dateTo?: string
  search?: string
}

/**
 * List purchase orders for a venue with optional filters.
 */
export async function listPurchaseOrders(venueId: string, page: number, pageSize: number, filters?: ListPOFilters) {
  const skip = (page - 1) * pageSize
  const where: any = { venueId }

  if (filters?.status) {
    const statuses = filters.status.split(',').map(s => s.trim()) as PurchaseOrderStatus[]
    where.status = { in: statuses }
  }

  if (filters?.dateFrom || filters?.dateTo) {
    where.orderDate = {}
    if (filters?.dateFrom) where.orderDate.gte = new Date(filters.dateFrom)
    if (filters?.dateTo) where.orderDate.lte = new Date(filters.dateTo + 'T23:59:59.999Z')
  }

  if (filters?.search) {
    const term = filters.search.trim()
    where.OR = [
      { orderNumber: { contains: term, mode: 'insensitive' } },
      { supplier: { name: { contains: term, mode: 'insensitive' } } },
      { notes: { contains: term, mode: 'insensitive' } },
    ]
  }

  const [orders, total] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where,
      include: {
        supplier: { select: { id: true, name: true } },
        items: {
          include: {
            rawMaterial: { select: { id: true, name: true, sku: true } },
            product: { select: { id: true, name: true, sku: true } }, // renglón de mercancía de reventa
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: pageSize,
    }),
    prisma.purchaseOrder.count({ where }),
  ])

  return {
    orders: orders.map(formatPurchaseOrder),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  }
}

// ============================================================================
// GET PURCHASE ORDER DETAIL
// ============================================================================

/**
 * Get a single purchase order with full details.
 */
export async function getPurchaseOrder(poId: string, venueId: string) {
  const po = await prisma.purchaseOrder.findFirst({
    where: { id: poId, venueId },
    include: {
      supplier: true,
      items: {
        include: {
          rawMaterial: { select: { id: true, name: true, sku: true, unit: true } },
          product: { select: { id: true, name: true, sku: true, unit: true } }, // renglón de mercancía de reventa
        },
      },
    },
  })

  if (!po) {
    throw new NotFoundError('Orden de compra no encontrada')
  }

  return formatPurchaseOrder(po)
}

// ============================================================================
// CREATE PURCHASE ORDER
// ============================================================================

interface CreatePOItem {
  rawMaterialId: string
  quantity: number
  unitPrice: number // cents
  unit?: string
  notes?: string
}

interface CreatePOParams {
  venueId: string
  staffId: string
  supplierName: string
  items: CreatePOItem[]
  notes?: string
  expectedDate?: string
}

/**
 * Create a new purchase order.
 * Finds or creates the supplier by name.
 */
export async function createPurchaseOrder(params: CreatePOParams) {
  const { venueId, staffId, supplierName, items, notes, expectedDate } = params

  if (!supplierName || !supplierName.trim()) {
    throw new BadRequestError('supplierName es requerido')
  }

  if (!items || items.length === 0) {
    throw new BadRequestError('Se requiere al menos un producto')
  }

  // Find or create supplier
  let supplier = await prisma.supplier.findFirst({
    where: { venueId, name: supplierName.trim(), deletedAt: null },
  })

  if (!supplier) {
    supplier = await prisma.supplier.create({
      data: {
        venueId,
        name: supplierName.trim(),
      },
    })
  }

  // Generate order number
  const orderNumber = `PO-${Date.now()}`

  // Resolve rawMaterialIds: if a product ID is provided, find or create a RawMaterial
  const resolvedItems = await Promise.all(
    items.map(async item => {
      let rmId = item.rawMaterialId

      // Check if the provided ID is a valid RawMaterial
      if (rmId) {
        const existing = await prisma.rawMaterial.findUnique({ where: { id: rmId } })
        if (!existing) {
          // It might be a Product ID — look up the product and find/create a RawMaterial
          const product = await prisma.product.findUnique({
            where: { id: rmId },
            select: { id: true, name: true, sku: true },
          })
          if (product) {
            let rm = await prisma.rawMaterial.findFirst({
              where: { venueId, sku: product.sku || `PROD-${product.id.slice(-6)}`, deletedAt: null },
            })
            if (!rm) {
              rm = await prisma.rawMaterial.create({
                data: {
                  venueId,
                  name: product.name,
                  sku: product.sku || `PROD-${product.id.slice(-6)}`,
                  category: 'OTHER',
                  currentStock: 0,
                  minimumStock: 0,
                  reorderPoint: 0,
                  reservedStock: 0,
                  costPerUnit: 0,
                  avgCostPerUnit: 0,
                  unit: 'PIECE',
                  unitType: 'COUNT',
                },
              })
            }
            rmId = rm.id
          }
        }
      }

      return { ...item, rawMaterialId: rmId }
    }),
  )

  // 🔴 Un renglón TIENE que apuntar a algo. Esta ruta no monta `validateRequest`, así
  // que la única defensa que tenía era la restricción NOT NULL de la base: si la
  // resolución de arriba no encontraba insumo, Prisma rechazaba el insert y no se
  // guardaba nada. Al volver `rawMaterialId` opcional —para permitir mercancía de
  // reventa— esa red desapareció y el renglón se habría guardado apuntando a NULL:
  // imposible de recibir, revienta el PDF y las etiquetas de TODA la orden, y mata en
  // silencio el correo al proveedor (es fire-and-forget).
  //
  // Hoy el CHECK de la base también lo impide, pero ahí el usuario recibiría un 500
  // de Postgres. Esto le dice qué renglón está mal y por qué.
  const sinDestino = resolvedItems.filter(item => !item.rawMaterialId)
  if (sinDestino.length > 0) {
    throw new BadRequestError(
      `${sinDestino.length} renglón(es) de la orden no corresponden a ningún insumo ni producto de esta sucursal. ` +
        `Revisa que los artículos existan antes de crear la orden.`,
    )
  }

  // Calculate totals
  let subtotal = 0
  const itemsData = resolvedItems.map(item => {
    const unitPrice = (item.unitPrice || 0) / 100 // cents to dollars
    const total = unitPrice * item.quantity
    subtotal += total

    return {
      rawMaterialId: item.rawMaterialId,
      quantityOrdered: item.quantity,
      unit: (item.unit as any) || 'PIECE',
      unitPrice,
      total,
      notes: item.notes || null,
    }
  })

  const taxRate = 0.16
  const taxAmount = subtotal * taxRate
  const total = subtotal + taxAmount

  const po = await prisma.purchaseOrder.create({
    data: {
      venueId,
      supplierId: supplier.id,
      orderNumber,
      status: 'DRAFT',
      orderDate: new Date(),
      expectedDeliveryDate: expectedDate ? new Date(expectedDate) : null,
      subtotal: new Decimal(subtotal.toFixed(2)),
      taxAmount: new Decimal(taxAmount.toFixed(2)),
      taxRate: new Decimal(taxRate.toFixed(4)),
      total: new Decimal(total.toFixed(2)),
      createdById: staffId,
      createdBy: staffId,
      notes: notes || null,
      items: {
        create: itemsData.map(item => ({
          rawMaterialId: item.rawMaterialId,
          quantityOrdered: new Decimal(item.quantityOrdered.toString()),
          unit: item.unit as any,
          unitPrice: new Decimal(item.unitPrice.toFixed(4)),
          total: new Decimal(item.total.toFixed(2)),
          notes: item.notes,
        })),
      },
    },
    include: {
      supplier: { select: { id: true, name: true } },
      items: {
        include: {
          rawMaterial: { select: { id: true, name: true, sku: true } },
          product: { select: { id: true, name: true, sku: true } }, // renglón de mercancía de reventa
        },
      },
    },
  })

  logAction({
    staffId,
    venueId,
    action: 'PURCHASE_ORDER_CREATED',
    entity: 'PurchaseOrder',
    entityId: po.id,
    data: { orderNumber, supplierName, itemCount: items.length, total, source: 'MOBILE' },
  })

  return formatPurchaseOrder(po)
}

// ============================================================================
// UPDATE STATUS
// ============================================================================

const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['PENDING_APPROVAL', 'SENT', 'CANCELLED'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED'],
  REJECTED: ['DRAFT', 'CANCELLED'],
  APPROVED: ['SENT', 'CANCELLED'],
  SENT: ['CONFIRMED', 'SHIPPED', 'PARTIAL', 'RECEIVED', 'CANCELLED'],
  CONFIRMED: ['SHIPPED', 'PARTIAL', 'RECEIVED', 'CANCELLED'],
  SHIPPED: ['PARTIAL', 'RECEIVED', 'CANCELLED'],
  PARTIAL: ['RECEIVED', 'CANCELLED'],
}

/**
 * Update the status of a purchase order.
 */
export async function updateStatus(poId: string, venueId: string, newStatus: string, staffId: string) {
  const po = await prisma.purchaseOrder.findFirst({
    where: { id: poId, venueId },
  })

  if (!po) {
    throw new NotFoundError('Orden de compra no encontrada')
  }

  const allowed = VALID_TRANSITIONS[po.status] || []
  if (!allowed.includes(newStatus)) {
    throw new BadRequestError(`No se puede cambiar de ${po.status} a ${newStatus}`)
  }

  const updateData: any = { status: newStatus as PurchaseOrderStatus }

  if (newStatus === 'APPROVED') {
    updateData.approvedBy = staffId
    updateData.approvedAt = new Date()
  } else if (newStatus === 'REJECTED') {
    updateData.rejectedBy = staffId
    updateData.rejectedAt = new Date()
  }

  const updated = await prisma.purchaseOrder.update({
    where: { id: poId },
    data: updateData,
    include: {
      supplier: { select: { id: true, name: true } },
      items: {
        include: {
          rawMaterial: { select: { id: true, name: true, sku: true } },
          product: { select: { id: true, name: true, sku: true } }, // renglón de mercancía de reventa
        },
      },
    },
  })

  logAction({
    staffId,
    venueId,
    action: 'PURCHASE_ORDER_STATUS_UPDATED',
    entity: 'PurchaseOrder',
    entityId: po.id,
    data: { from: po.status, to: newStatus, source: 'MOBILE' },
  })

  return formatPurchaseOrder(updated)
}

// ============================================================================
// RECEIVE STOCK
// ============================================================================

interface ReceiveItem {
  itemId: string // PurchaseOrderItem ID
  receivedQuantity: number
}

/**
 * Receive stock for a purchase order.
 *
 * Delegates each item to applyItemReceiveStatusInTx — the same receive
 * state-machine used by the dashboard — inside ONE transaction, so every
 * received item gets its FIFO StockBatch, the quantity is converted from the
 * PO unit to the raw material's storage unit, currentStock and the PURCHASE
 * movement commit atomically, and over-receiving beyond quantityOrdered is
 * rejected.
 */
export async function receiveStock(poId: string, venueId: string, items: ReceiveItem[], staffId: string) {
  const po = await prisma.purchaseOrder.findFirst({
    where: { id: poId, venueId },
    include: {
      items: {
        include: {
          rawMaterial: true,
          product: true, // renglón de mercancía de reventa
        },
      },
    },
  })

  if (!po) {
    throw new NotFoundError('Orden de compra no encontrada')
  }

  const validStatuses: string[] = ['SENT', 'CONFIRMED', 'SHIPPED', 'PARTIAL', 'APPROVED']
  if (!validStatuses.includes(po.status)) {
    throw new BadRequestError(`No se puede recibir stock en estado ${po.status}`)
  }

  // Mobile sends DELTAS (quantity received in this scan); the shared
  // state-machine takes the ABSOLUTE accumulated target, so convert first.
  await prisma.$transaction(async tx => {
    for (const receiveItem of items) {
      const poItem = po.items.find(i => i.id === receiveItem.itemId)
      if (!poItem) continue
      if (!(receiveItem.receivedQuantity > 0)) continue

      const targetQty = Number(poItem.quantityReceived) + receiveItem.receivedQuantity
      if (targetQty > Number(poItem.quantityOrdered)) {
        throw new BadRequestError(
          `No se puede recibir ${receiveItem.receivedQuantity} ${poItem.unit} de "${poItem.rawMaterial?.name ?? poItem.product?.name ?? 'el artículo'}": ` +
            `excede la cantidad ordenada (${Number(poItem.quantityOrdered)} ${poItem.unit}).`,
        )
      }

      await applyItemReceiveStatusInTx(
        tx,
        venueId,
        poId,
        poItem.id,
        {
          receiveStatus: PurchaseOrderItemStatus.RECEIVED,
          quantityReceived: targetQty,
        } as UpdatePurchaseOrderItemStatusDto,
        staffId,
      )
    }
  })

  // Determine overall PO status
  const updatedPO = await prisma.purchaseOrder.findFirst({
    where: { id: poId },
    include: { items: true },
  })

  if (updatedPO) {
    const allReceived = updatedPO.items.every(item => Number(item.quantityReceived) >= Number(item.quantityOrdered))
    const someReceived = updatedPO.items.some(item => Number(item.quantityReceived) > 0)

    let newStatus: PurchaseOrderStatus = po.status as PurchaseOrderStatus
    if (allReceived) {
      newStatus = 'RECEIVED'
    } else if (someReceived) {
      newStatus = 'PARTIAL'
    }

    if (newStatus !== po.status) {
      await prisma.purchaseOrder.update({
        where: { id: poId },
        data: {
          status: newStatus,
          receivedDate: allReceived ? new Date() : null,
          receivedBy: allReceived ? staffId : null,
        },
      })
    }
  }

  logAction({
    staffId,
    venueId,
    action: 'PURCHASE_ORDER_RECEIVED',
    entity: 'PurchaseOrder',
    entityId: po.id,
    data: {
      itemsReceived: items.length,
      source: 'MOBILE',
    },
  })

  // Return updated PO
  return getPurchaseOrder(poId, venueId)
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Format a Prisma PurchaseOrder for the mobile API response.
 *
 * BUG FIX (Bug 3): The Android client expects item fields named
 *   { productId, productName, sku, orderedQuantity, receivedQuantity, unitCost }
 * while the internal database uses the raw-material terminology
 *   { rawMaterialId, rawMaterialName, rawMaterialSku, quantityOrdered, quantityReceived, unitPrice }.
 *
 * To maintain backward compatibility with existing clients (e.g. iOS) while
 * also satisfying the Android client's expectations, each item includes BOTH
 * sets of field names. The mobile app's Kotlin models use @SerialName to map
 * the legacy names onto its internal fields (see PurchaseOrderModels.kt), and
 * the added aliases give us flexibility if/when Android switches to reading
 * the new names directly.
 */
function formatPurchaseOrder(po: any) {
  return {
    id: po.id,
    venueId: po.venueId,
    orderNumber: po.orderNumber,
    supplierName: po.supplier?.name || '',
    status: po.status,
    orderDate: po.orderDate.toISOString(),
    expectedDeliveryDate: po.expectedDeliveryDate ? po.expectedDeliveryDate.toISOString() : null,
    // Alias for Android client which reads `expectedDate`
    expectedDate: po.expectedDeliveryDate ? po.expectedDeliveryDate.toISOString() : null,
    receivedDate: po.receivedDate ? po.receivedDate.toISOString() : null,
    supplier: po.supplier
      ? {
          id: po.supplier.id,
          name: po.supplier.name,
        }
      : null,
    subtotal: Math.round(Number(po.subtotal) * 100),
    taxAmount: Math.round(Number(po.taxAmount) * 100),
    total: Math.round(Number(po.total) * 100),
    notes: po.notes,
    createdBy: po.createdBy,
    createdByName: '',
    items: po.items
      ? po.items.map((item: any) => {
          const unitPriceCents = Math.round(Number(item.unitPrice) * 100)
          const totalCents = Math.round(Number(item.total) * 100)
          const quantityOrdered = Number(item.quantityOrdered)
          const quantityReceived = Number(item.quantityReceived)

          return {
            id: item.id,
            // Legacy/internal field names (preserved for iOS and backward compatibility)
            rawMaterialId: item.rawMaterialId,
            // Un renglón puede ser mercancía de reventa (`product`) en vez de insumo.
            // Sin el respaldo, iOS y Android pintan un renglón SIN NOMBRE y sin id con
            // el que casarlo al escanear. Los campos NO cambian de forma ni
            // desaparecen: sólo dejan de venir en null cuando la línea es de producto.
            rawMaterialName: item.rawMaterial?.name ?? item.product?.name ?? null,
            rawMaterialSku: item.rawMaterial?.sku ?? item.product?.sku ?? null,
            quantityOrdered,
            quantityReceived,
            unitPrice: unitPriceCents,
            // New field aliases expected by the Android client
            productId: item.productId ?? item.rawMaterialId,
            productName: item.rawMaterial?.name ?? item.product?.name ?? null,
            sku: item.rawMaterial?.sku ?? item.product?.sku ?? null,
            // Qué tipo de renglón es, para que el cliente no tenga que adivinar por
            // cuál de los dos ids vino. Campo NUEVO y opcional: los clientes viejos
            // simplemente lo ignoran.
            itemKind: item.productId ? 'PRODUCT' : 'RAW_MATERIAL',
            orderedQuantity: quantityOrdered,
            receivedQuantity: quantityReceived,
            // `unitCost` is expressed in decimal currency (not cents) to match
            // the Android `CreatePOItemRequest.unitCost: Double` contract.
            unitCost: Number(item.unitPrice),
            // Also expose the purchase-order-item id under the Android name
            purchaseOrderItemId: item.id,
            unit: item.unit,
            total: totalCents,
            receiveStatus: item.receiveStatus,
            notes: item.notes,
          }
        })
      : [],
    createdAt: po.createdAt.toISOString(),
    updatedAt: po.updatedAt.toISOString(),
  }
}
