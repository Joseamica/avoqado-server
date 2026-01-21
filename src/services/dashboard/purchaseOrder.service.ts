import { PurchaseOrder, PurchaseOrderStatus, PurchaseOrderItemStatus, RawMaterialMovementType, Prisma, Unit } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import AppError from '../../errors/AppError'
import {
  CreatePurchaseOrderDto,
  UpdatePurchaseOrderDto,
  ReceivePurchaseOrderDto,
  UpdatePurchaseOrderFeesDto,
  UpdatePurchaseOrderItemStatusDto,
  ReceiveAllItemsDto,
  ReceiveNoItemsDto,
} from '../../schemas/dashboard/inventory.schema'
import { Decimal } from '@prisma/client/runtime/library'
import { createStockBatch } from './fifoBatch.service'
import { sendPurchaseOrderEmail } from '../resend.service'
import logger from '@/config/logger'
import PDFDocument from 'pdfkit'
import { getLabelTemplate, calculateLabelPosition } from '../labels/labelTemplates'
import { generateBarcode, getRecommendedBarcodeFormat } from '../labels/barcodeGenerator'

async function getStaffSummary(staffId?: string | null) {
  if (!staffId) return null
  const staff = await prisma.staff.findUnique({
    where: { id: staffId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
    },
  })

  if (!staff) return null

  const name = [staff.firstName, staff.lastName].filter(Boolean).join(' ').trim()

  return {
    id: staff.id,
    name: name || staff.email,
    email: staff.email,
  }
}

/**
 * Generate unique order number
 */
async function generateOrderNumber(venueId: string): Promise<string> {
  const today = new Date()
  const datePrefix = `PO${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`

  const lastOrder = await prisma.purchaseOrder.findFirst({
    where: {
      venueId,
      orderNumber: {
        startsWith: datePrefix,
      },
    },
    orderBy: {
      orderNumber: 'desc',
    },
  })

  if (!lastOrder) {
    return `${datePrefix}-001`
  }

  const lastSequence = parseInt(lastOrder.orderNumber.split('-')[1])
  const nextSequence = String(lastSequence + 1).padStart(3, '0')
  return `${datePrefix}-${nextSequence}`
}

/**
 * Helper function to send Purchase Order email (async, non-blocking)
 */
async function sendPurchaseOrderEmailAsync(venueId: string, purchaseOrderId: string, staffId?: string): Promise<void> {
  try {
    // Fetch complete PO data
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      include: {
        supplier: true,
        items: {
          include: {
            rawMaterial: true,
          },
        },
        venue: {
          select: {
            name: true,
            address: true,
            city: true,
            state: true,
            zipCode: true,
          },
        },
      },
    })

    if (!po) {
      logger.warn(`Purchase Order ${purchaseOrderId} not found for email sending`)
      return
    }

    // Check if supplier has email
    if (!po.supplier.email) {
      logger.warn(`Supplier ${po.supplier.name} (ID: ${po.supplierId}) has no email address - skipping PO email`)
      return
    }

    // Fetch staff details if staffId provided
    let staffName = 'N/A'
    let staffEmail = ''

    if (staffId) {
      const staff = await prisma.staff.findUnique({
        where: { id: staffId },
        select: { firstName: true, lastName: true, email: true },
      })

      if (staff) {
        staffName = `${staff.firstName} ${staff.lastName}`
        staffEmail = staff.email || ''
      }
    }

    // Determine shipping address
    // If custom shipping address is provided, use it. Otherwise use venue address.
    const useCustomShipping = po.shippingAddressType === 'CUSTOM' && po.shippingAddress
    const shippingAddress = useCustomShipping ? po.shippingAddress! : po.venue?.address || 'N/A'
    const shippingCity = useCustomShipping ? po.shippingCity! : po.venue?.city || 'N/A'
    const shippingState = useCustomShipping ? po.shippingState! : po.venue?.state || 'N/A'
    const shippingZipCode = useCustomShipping ? po.shippingZipCode! : po.venue?.zipCode || 'N/A'

    // Format items for email
    const formattedItems = po.items.map(item => ({
      name: item.rawMaterial.name,
      quantity: item.quantityOrdered.toNumber(),
      unit: item.unit,
      unitPrice: item.unitPrice.toFixed(2),
      total: item.total.toFixed(2),
    }))

    // Send email
    const emailSent = await sendPurchaseOrderEmail({
      orderNumber: po.orderNumber,
      orderDate: po.orderDate.toISOString(),
      expectedDeliveryDate: po.expectedDeliveryDate?.toISOString() || null,
      venueName: po.venue?.name || 'N/A',
      venueAddress: shippingAddress,
      venueCity: shippingCity,
      venueState: shippingState,
      venueZipCode: shippingZipCode,
      supplierName: po.supplier.name,
      supplierContactName: po.supplier.contactName || null,
      supplierEmail: po.supplier.email,
      staffName,
      staffEmail,
      items: formattedItems,
      subtotal: po.subtotal.toFixed(2),
      taxRate: po.taxRate.toNumber(),
      taxAmount: po.taxAmount.toFixed(2),
      total: po.total.toFixed(2),
      notes: po.notes || null,
    })

    if (emailSent) {
      logger.info(`✅ Purchase Order email sent successfully for ${po.orderNumber}`)
    } else {
      logger.warn(`⚠️ Purchase Order email sending failed for ${po.orderNumber} (non-critical)`)
    }
  } catch (error) {
    logger.error(`Error in sendPurchaseOrderEmailAsync for PO ${purchaseOrderId}:`, error)
    // Don't throw - email failure should not affect PO creation
  }
}

/**
 * Get all purchase orders for a venue
 */
export async function getPurchaseOrders(
  venueId: string,
  filters?: {
    status?: PurchaseOrderStatus
    supplierId?: string
    startDate?: Date
    endDate?: Date
  },
): Promise<PurchaseOrder[]> {
  const where: Prisma.PurchaseOrderWhereInput = {
    venueId,
    ...(filters?.status && { status: filters.status }),
    ...(filters?.supplierId && { supplierId: filters.supplierId }),
    ...(filters?.startDate && { orderDate: { gte: filters.startDate } }),
    ...(filters?.endDate && { orderDate: { lte: filters.endDate } }),
  }

  const purchaseOrders = await prisma.purchaseOrder.findMany({
    where,
    include: {
      supplier: {
        select: {
          id: true,
          name: true,
          contactName: true,
          email: true,
          phone: true,
        },
      },
      items: {
        include: {
          rawMaterial: {
            select: {
              id: true,
              name: true,
              sku: true,
              unit: true,
              currentStock: true,
            },
          },
        },
      },
    },
    orderBy: {
      orderDate: 'desc',
    },
  })

  return purchaseOrders as any
}

/**
 * Get a single purchase order by ID
 */
export async function getPurchaseOrder(venueId: string, purchaseOrderId: string): Promise<PurchaseOrder | null> {
  const purchaseOrder = await prisma.purchaseOrder.findFirst({
    where: {
      id: purchaseOrderId,
      venueId,
    },
    include: {
      supplier: true,
      items: {
        include: {
          rawMaterial: true,
        },
      },
    },
  })

  if (!purchaseOrder) return null

  const createdBy = await getStaffSummary(purchaseOrder.createdBy)

  return {
    ...purchaseOrder,
    createdById: purchaseOrder.createdById || purchaseOrder.createdBy || null,
    createdBy,
  } as any
}

/**
 * Create a new purchase order
 */
export async function createPurchaseOrder(venueId: string, data: CreatePurchaseOrderDto, staffId?: string): Promise<PurchaseOrder> {
  // Verify supplier exists and belongs to venue
  const supplier = await prisma.supplier.findFirst({
    where: {
      id: data.supplierId,
      venueId,
    },
  })

  if (!supplier) {
    throw new AppError(`Supplier with ID ${data.supplierId} not found`, 404)
  }

  // Verify all raw materials exist
  const rawMaterialIds = data.items.map(item => item.rawMaterialId)
  const rawMaterials = await prisma.rawMaterial.findMany({
    where: {
      id: { in: rawMaterialIds },
      venueId,
    },
  })

  if (rawMaterials.length !== rawMaterialIds.length) {
    throw new AppError('Some raw materials not found', 404)
  }

  // Calculate totals
  const subtotal = data.items.reduce((sum, item) => {
    return sum.add(new Decimal(item.unitPrice).mul(item.quantityOrdered))
  }, new Decimal(0))

  const taxRate = data.taxRate || 0.16
  const taxAmount = subtotal.mul(taxRate)

  const commissionRate = data.commissionRate || 0
  const commission = subtotal.mul(commissionRate)

  const totalAmount = subtotal.add(taxAmount).add(commission)

  // Check minimum order requirement
  if (supplier.minimumOrder && totalAmount.lessThan(supplier.minimumOrder)) {
    throw new AppError(`Order total ${totalAmount.toNumber()} is below supplier minimum order of ${supplier.minimumOrder.toNumber()}`, 400)
  }

  // Generate order number
  const orderNumber = await generateOrderNumber(venueId)

  // Create purchase order with items
  const purchaseOrder = await prisma.purchaseOrder.create({
    data: {
      venueId,
      supplierId: data.supplierId,
      orderNumber,
      orderDate: new Date(data.orderDate),
      expectedDeliveryDate: data.expectedDeliveryDate ? new Date(data.expectedDeliveryDate) : undefined,
      status: PurchaseOrderStatus.DRAFT,
      subtotal,
      taxRate,
      taxAmount,
      commissionRate,
      commission,
      total: totalAmount,
      notes: data.notes,
      createdBy: staffId,
      // Shipping address fields
      shippingAddressType: data.shippingAddressType || 'VENUE',
      shippingAddress: data.shippingAddress,
      shippingCity: data.shippingCity,
      shippingState: data.shippingState,
      shippingZipCode: data.shippingZipCode,
      items: {
        create: data.items.map(item => {
          const itemTotal = new Decimal(item.unitPrice).mul(item.quantityOrdered)
          return {
            rawMaterial: {
              connect: { id: item.rawMaterialId },
            },
            quantityOrdered: item.quantityOrdered,
            unit: item.unit as Unit,
            unitPrice: item.unitPrice,
            total: itemTotal,
            quantityReceived: 0,
          }
        }),
      },
    },
    include: {
      supplier: true,
      items: {
        include: {
          rawMaterial: true,
        },
      },
    },
  })

  // Send email notification to supplier and staff (non-blocking)
  // This is async but we don't await it - email failures should not block PO creation
  sendPurchaseOrderEmailAsync(venueId, purchaseOrder.id, staffId).catch(error => {
    logger.error(`Failed to send Purchase Order email for PO ${purchaseOrder.orderNumber}:`, error)
  })

  return purchaseOrder as any
}

/**
 * Update a purchase order
 */
export async function updatePurchaseOrder(
  venueId: string,
  purchaseOrderId: string,
  data: UpdatePurchaseOrderDto,
  _staffId?: string,
): Promise<PurchaseOrder> {
  const existingOrder = await prisma.purchaseOrder.findFirst({
    where: {
      id: purchaseOrderId,
      venueId,
    },
    include: {
      items: true,
    },
  })

  if (!existingOrder) {
    throw new AppError(`Purchase order with ID ${purchaseOrderId} not found`, 404)
  }

  // Prevent editing received orders (except for undoing receive: RECEIVED → SHIPPED)
  if (existingOrder.status === PurchaseOrderStatus.RECEIVED) {
    // Allow RECEIVED → SHIPPED transition (undo receive)
    if (data.status !== PurchaseOrderStatus.SHIPPED) {
      throw new AppError(`Cannot edit purchase order with status ${existingOrder.status}`, 400)
    }
  }

  let updateData: Prisma.PurchaseOrderUpdateInput = {
    status: data.status,
    expectedDeliveryDate: data.expectedDeliveryDate ? new Date(data.expectedDeliveryDate) : undefined,
    notes: data.notes,
  }

  // If items are being updated, recalculate totals
  if (data.items) {
    const subtotal = data.items.reduce((sum, item) => {
      return sum.add(new Decimal(item.unitPrice).mul(item.quantityOrdered))
    }, new Decimal(0))

    const taxAmount = subtotal.mul(existingOrder.taxRate)
    const totalAmount = subtotal.add(taxAmount)

    updateData = {
      ...updateData,
      subtotal,
      taxAmount,
      total: totalAmount,
    }

    // Delete old items and create new ones
    await prisma.purchaseOrderItem.deleteMany({
      where: { purchaseOrderId },
    })
  }

  const purchaseOrder = await prisma.purchaseOrder.update({
    where: { id: purchaseOrderId },
    data: data.items
      ? {
          ...updateData,
          items: {
            create: data.items.map(item => {
              const itemTotal = new Decimal(item.unitPrice).mul(item.quantityOrdered)
              return {
                rawMaterial: {
                  connect: { id: item.rawMaterialId },
                },
                quantityOrdered: item.quantityOrdered,
                unit: item.unit as Unit,
                unitPrice: item.unitPrice,
                total: itemTotal,
                quantityReceived: 0,
              }
            }),
          },
        }
      : updateData,
    include: {
      supplier: true,
      items: {
        include: {
          rawMaterial: true,
        },
      },
    },
  })

  return purchaseOrder as any
}

/**
 * Delete a purchase order (DRAFT only)
 */
export async function deletePurchaseOrder(venueId: string, purchaseOrderId: string): Promise<PurchaseOrder> {
  const existingOrder = await prisma.purchaseOrder.findFirst({
    where: {
      id: purchaseOrderId,
      venueId,
    },
    include: {
      supplier: true,
      items: true,
    },
  })

  if (!existingOrder) {
    throw new AppError(`Purchase order with ID ${purchaseOrderId} not found`, 404)
  }

  if (existingOrder.status !== PurchaseOrderStatus.DRAFT) {
    throw new AppError('Only DRAFT purchase orders can be deleted', 400)
  }

  await prisma.$transaction([
    prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrderId } }),
    prisma.purchaseOrder.delete({ where: { id: purchaseOrderId } }),
  ])

  return existingOrder as any
}

/**
 * Approve a purchase order (change status to APPROVED)
 * @deprecated Use purchaseOrderWorkflow.service.approvePurchaseOrder instead
 */
export async function approvePurchaseOrder(venueId: string, purchaseOrderId: string, staffId?: string): Promise<PurchaseOrder> {
  const order = await prisma.purchaseOrder.findFirst({
    where: {
      id: purchaseOrderId,
      venueId,
    },
  })

  if (!order) {
    throw new AppError(`Purchase order not found`, 404)
  }

  // Allow approval from DRAFT or PENDING_APPROVAL
  const allowedStatuses = [PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.PENDING_APPROVAL] as PurchaseOrderStatus[]
  if (!allowedStatuses.includes(order.status)) {
    throw new AppError(`Can only approve orders with status DRAFT or PENDING_APPROVAL`, 400)
  }

  const updatedOrder = await prisma.purchaseOrder.update({
    where: { id: purchaseOrderId },
    data: {
      status: PurchaseOrderStatus.APPROVED,
      approvedBy: staffId,
      approvedAt: new Date(),
    },
    include: {
      supplier: true,
      items: {
        include: {
          rawMaterial: true,
        },
      },
    },
  })

  return updatedOrder as any
}

/**
 * Receive a purchase order (mark items as received and update stock)
 */
export async function receivePurchaseOrder(
  venueId: string,
  purchaseOrderId: string,
  data: ReceivePurchaseOrderDto,
  staffId?: string,
): Promise<PurchaseOrder> {
  const order = await prisma.purchaseOrder.findFirst({
    where: {
      id: purchaseOrderId,
      venueId,
    },
    include: {
      items: {
        include: {
          rawMaterial: true,
        },
      },
    },
  })

  if (!order) {
    throw new AppError(`Purchase order not found`, 404)
  }

  const allowedStatuses = [PurchaseOrderStatus.CONFIRMED, PurchaseOrderStatus.SHIPPED, PurchaseOrderStatus.PARTIAL] as PurchaseOrderStatus[]
  if (!allowedStatuses.includes(order.status)) {
    throw new AppError(`Can only receive orders with status CONFIRMED, SHIPPED, or PARTIAL. Current status: ${order.status}`, 400)
  }

  // Build transaction operations
  const operations = []

  // Track created batches for linking to movements
  const batchCreations: Array<{ itemId: string; batchPromise: Promise<any> }> = []

  for (const receivedItem of data.items) {
    const orderItem = order.items.find(item => item.id === receivedItem.purchaseOrderItemId)

    if (!orderItem) {
      throw new AppError(`Purchase order item ${receivedItem.purchaseOrderItemId} not found`, 404)
    }

    const totalReceived = orderItem.quantityReceived.add(receivedItem.quantityReceived)

    if (totalReceived.greaterThan(orderItem.quantityOrdered)) {
      throw new AppError(
        `Cannot receive ${receivedItem.quantityReceived} of ${orderItem.rawMaterial.name}. Total would exceed ordered quantity.`,
        400,
      )
    }

    // Calculate expiration date if perishable
    let expirationDate: Date | undefined
    if (orderItem.rawMaterial.perishable && orderItem.rawMaterial.shelfLifeDays) {
      expirationDate = new Date(data.receivedDate)
      expirationDate.setDate(expirationDate.getDate() + orderItem.rawMaterial.shelfLifeDays)
    }

    // Create FIFO batch for this received quantity
    const batchPromise = createStockBatch(venueId, orderItem.rawMaterialId, {
      purchaseOrderItemId: orderItem.id,
      quantity: receivedItem.quantityReceived,
      unit: orderItem.unit,
      costPerUnit: orderItem.unitPrice.toNumber(),
      receivedDate: new Date(data.receivedDate),
      expirationDate,
    })

    batchCreations.push({ itemId: orderItem.id, batchPromise })

    // Update order item quantity received
    operations.push(
      prisma.purchaseOrderItem.update({
        where: { id: orderItem.id },
        data: {
          quantityReceived: totalReceived,
        },
      }),
    )

    // Update raw material stock
    const newStock = orderItem.rawMaterial.currentStock.add(receivedItem.quantityReceived)
    operations.push(
      prisma.rawMaterial.update({
        where: { id: orderItem.rawMaterialId },
        data: {
          currentStock: newStock,
        },
      }),
    )
  }

  // Wait for all batches to be created (outside transaction to avoid nesting)
  const createdBatches = await Promise.all(batchCreations.map(bc => bc.batchPromise))

  // Create movement records linked to batches
  for (let i = 0; i < data.items.length; i++) {
    const receivedItem = data.items[i]
    const orderItem = order.items.find(item => item.id === receivedItem.purchaseOrderItemId)!
    const batch = createdBatches[i]

    operations.push(
      prisma.rawMaterialMovement.create({
        data: {
          rawMaterialId: orderItem.rawMaterialId,
          venueId,
          batchId: batch.id, // Link to created batch
          type: RawMaterialMovementType.PURCHASE,
          quantity: receivedItem.quantityReceived,
          unit: orderItem.unit,
          previousStock: orderItem.rawMaterial.currentStock,
          newStock: orderItem.rawMaterial.currentStock.add(receivedItem.quantityReceived),
          costImpact: batch.costPerUnit.mul(receivedItem.quantityReceived), // Cost from batch
          reason: `Purchase order ${order.orderNumber} received (Batch: ${batch.batchNumber})`,
          reference: order.id,
          createdBy: staffId,
        },
      }),
    )
  }

  // Update purchase order metadata
  operations.push(
    prisma.purchaseOrder.update({
      where: { id: purchaseOrderId },
      data: {
        receivedDate: new Date(data.receivedDate),
        receivedBy: staffId,
      },
    }),
  )

  // Execute all operations in a transaction
  await prisma.$transaction(operations)

  // Update order status based on item statuses (considers RECEIVED, DAMAGED, NOT_PROCESSED)
  await updatePurchaseOrderStatusBasedOnItems(purchaseOrderId)

  // Fetch updated order
  const updatedOrder = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    include: {
      supplier: true,
      items: {
        include: {
          rawMaterial: true,
        },
      },
    },
  })

  return updatedOrder as any
}

/**
 * Cancel a purchase order
 */
export async function cancelPurchaseOrder(
  venueId: string,
  purchaseOrderId: string,
  reason?: string,
  _staffId?: string,
): Promise<PurchaseOrder> {
  const order = await prisma.purchaseOrder.findFirst({
    where: {
      id: purchaseOrderId,
      venueId,
    },
  })

  if (!order) {
    throw new AppError(`Purchase order not found`, 404)
  }

  if (order.status === PurchaseOrderStatus.RECEIVED) {
    throw new AppError(`Cannot cancel order with status ${order.status}`, 400)
  }

  const updatedOrder = await prisma.purchaseOrder.update({
    where: { id: purchaseOrderId },
    data: {
      status: PurchaseOrderStatus.CANCELLED,
      notes: reason ? `${order.notes || ''}\nCancellation reason: ${reason}` : order.notes,
    },
    include: {
      supplier: true,
      items: {
        include: {
          rawMaterial: true,
        },
      },
    },
  })

  return updatedOrder as any
}

/**
 * Get purchase order statistics
 */
export async function getPurchaseOrderStats(venueId: string, startDate?: Date, endDate?: Date) {
  const dateFilter = {
    ...(startDate && { gte: startDate }),
    ...(endDate && { lte: endDate }),
  }

  const orders = await prisma.purchaseOrder.findMany({
    where: {
      venueId,
      ...(Object.keys(dateFilter).length > 0 && { orderDate: dateFilter }),
    },
  })

  const totalOrders = orders.length
  const draftOrders = orders.filter(o => o.status === PurchaseOrderStatus.DRAFT).length
  const sentOrders = orders.filter(o => o.status === PurchaseOrderStatus.SENT).length
  const confirmedOrders = orders.filter(o => o.status === PurchaseOrderStatus.CONFIRMED).length
  const shippedOrders = orders.filter(o => o.status === PurchaseOrderStatus.SHIPPED).length
  const receivedOrders = orders.filter(o => o.status === PurchaseOrderStatus.RECEIVED).length
  const partialOrders = orders.filter(o => o.status === PurchaseOrderStatus.PARTIAL).length
  const cancelledOrders = orders.filter(o => o.status === PurchaseOrderStatus.CANCELLED).length

  const totalSpent = orders.filter(o => o.status !== PurchaseOrderStatus.CANCELLED).reduce((sum, o) => sum.add(o.total), new Decimal(0))

  const averageOrderValue = totalOrders > 0 ? totalSpent.div(totalOrders) : new Decimal(0)

  return {
    period: { startDate, endDate },
    totalOrders,
    statusBreakdown: {
      draft: draftOrders,
      sent: sentOrders,
      confirmed: confirmedOrders,
      shipped: shippedOrders,
      received: receivedOrders,
      partial: partialOrders,
      cancelled: cancelledOrders,
    },
    financials: {
      totalSpent: totalSpent.toNumber(),
      averageOrderValue: averageOrderValue.toNumber(),
    },
  }
}

/**
 * Update tax rate and/or commission rate on an existing purchase order
 * Recalculates all totals based on new rates
 */
export async function updatePurchaseOrderFees(
  venueId: string,
  purchaseOrderId: string,
  data: UpdatePurchaseOrderFeesDto,
): Promise<PurchaseOrder> {
  // Fetch current purchase order with items
  const existingOrder = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId, venueId },
    include: { items: true },
  })

  if (!existingOrder) {
    throw new AppError('Purchase order not found', 404)
  }

  // Only allow updates on DRAFT or SENT orders
  const allowedStatuses: PurchaseOrderStatus[] = [PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.SENT]
  if (!allowedStatuses.includes(existingOrder.status)) {
    throw new AppError('Cannot update fees on orders that are already confirmed or received', 400)
  }

  // Use existing rates if not provided in update
  const newTaxRate = data.taxRate !== undefined ? new Decimal(data.taxRate) : existingOrder.taxRate
  const newCommissionRate = data.commissionRate !== undefined ? new Decimal(data.commissionRate) : existingOrder.commissionRate

  // Recalculate totals
  const subtotal = existingOrder.subtotal
  const taxAmount = subtotal.mul(newTaxRate)
  const commission = subtotal.mul(newCommissionRate)
  const total = subtotal.add(taxAmount).add(commission)

  // Update purchase order
  const updatedOrder = await prisma.purchaseOrder.update({
    where: { id: purchaseOrderId },
    data: {
      taxRate: newTaxRate,
      taxAmount,
      commissionRate: newCommissionRate,
      commission,
      total,
    },
    include: {
      supplier: true,
      items: {
        include: {
          rawMaterial: true,
        },
      },
    },
  })

  return updatedOrder
}

/**
 * Update the receive status of an individual purchase order item
 */
export async function updatePurchaseOrderItemStatus(
  venueId: string,
  purchaseOrderId: string,
  itemId: string,
  data: UpdatePurchaseOrderItemStatusDto,
): Promise<void> {
  // Verify purchase order exists and belongs to venue
  const purchaseOrder = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId, venueId },
    include: { items: true },
  })

  if (!purchaseOrder) {
    throw new AppError('Purchase order not found', 404)
  }

  // Verify item belongs to this purchase order
  const item = purchaseOrder.items.find(i => i.id === itemId)
  if (!item) {
    throw new AppError('Purchase order item not found', 404)
  }

  // Update item status
  await prisma.purchaseOrderItem.update({
    where: { id: itemId },
    data: {
      receiveStatus: data.receiveStatus,
      quantityReceived: data.quantityReceived !== undefined ? data.quantityReceived : item.quantityReceived,
      notes: data.notes,
    },
  })

  // After updating item status, check if we need to update the overall PO status
  await updatePurchaseOrderStatusBasedOnItems(purchaseOrderId)
}

/**
 * Mark all items in a purchase order as RECEIVED with full quantities
 */
export async function receiveAllItems(
  venueId: string,
  purchaseOrderId: string,
  data: ReceiveAllItemsDto,
  staffId?: string,
): Promise<PurchaseOrder> {
  // Fetch purchase order with items
  const purchaseOrder = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId, venueId },
    include: { items: true },
  })

  if (!purchaseOrder) {
    throw new AppError('Purchase order not found', 404)
  }

  // Only allow receiving on SHIPPED, CONFIRMED, or CANCELLED orders (CANCELLED to allow reverting "receive none")
  const allowedReceiveStatuses: PurchaseOrderStatus[] = [
    PurchaseOrderStatus.SHIPPED,
    PurchaseOrderStatus.CONFIRMED,
    PurchaseOrderStatus.CANCELLED,
  ]
  if (!allowedReceiveStatuses.includes(purchaseOrder.status)) {
    throw new AppError('Can only receive orders that are SHIPPED, CONFIRMED, or CANCELLED', 400)
  }

  const receivedDate = data.receivedDate ? new Date(data.receivedDate) : new Date()

  await prisma.$transaction(async tx => {
    // Update each item individually to set quantityReceived = quantityOrdered
    for (const item of purchaseOrder.items) {
      await tx.purchaseOrderItem.update({
        where: { id: item.id },
        data: {
          receiveStatus: PurchaseOrderItemStatus.RECEIVED,
          quantityReceived: item.quantityOrdered,
        },
      })

      // Create stock batch for FIFO tracking
      await createStockBatch(venueId, item.rawMaterialId, {
        purchaseOrderItemId: item.id,
        quantity: item.quantityOrdered.toNumber(),
        unit: item.unit,
        costPerUnit: item.unitPrice.toNumber(),
        receivedDate,
        expirationDate: undefined, // Can be set separately if needed
      })
    }

    // Update purchase order status to RECEIVED
    await tx.purchaseOrder.update({
      where: { id: purchaseOrderId },
      data: {
        status: PurchaseOrderStatus.RECEIVED,
        receivedDate,
        receivedBy: staffId,
      },
    })
  })

  // Return updated purchase order
  return await prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: purchaseOrderId },
    include: {
      supplier: true,
      items: {
        include: {
          rawMaterial: true,
        },
      },
    },
  })
}

/**
 * Mark all items in a purchase order as NOT_PROCESSED
 */
export async function receiveNoItems(venueId: string, purchaseOrderId: string, data: ReceiveNoItemsDto): Promise<PurchaseOrder> {
  // Fetch purchase order
  const purchaseOrder = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId, venueId },
    include: { items: true },
  })

  if (!purchaseOrder) {
    throw new AppError('Purchase order not found', 404)
  }

  // Only allow on SHIPPED, CONFIRMED, or RECEIVED orders
  const allowedNotProcessedStatuses: PurchaseOrderStatus[] = [
    PurchaseOrderStatus.SHIPPED,
    PurchaseOrderStatus.CONFIRMED,
    PurchaseOrderStatus.RECEIVED,
  ]
  if (!allowedNotProcessedStatuses.includes(purchaseOrder.status)) {
    throw new AppError('Can only mark as not processed on orders that are SHIPPED, CONFIRMED, or RECEIVED', 400)
  }

  await prisma.$transaction(async tx => {
    // Update all items to NOT_PROCESSED
    await tx.purchaseOrderItem.updateMany({
      where: { purchaseOrderId },
      data: {
        receiveStatus: PurchaseOrderItemStatus.NOT_PROCESSED,
        quantityReceived: 0,
        notes: data.reason || 'Items not processed',
      },
    })

    // Update purchase order status to CANCELLED
    await tx.purchaseOrder.update({
      where: { id: purchaseOrderId },
      data: {
        status: PurchaseOrderStatus.CANCELLED,
        notes: data.reason ? `${purchaseOrder.notes || ''}\n\nCancellation reason: ${data.reason}`.trim() : purchaseOrder.notes,
      },
    })
  })

  // Return updated purchase order
  return await prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: purchaseOrderId },
    include: {
      supplier: true,
      items: {
        include: {
          rawMaterial: true,
        },
      },
    },
  })
}

/**
 * Helper function to update purchase order status based on item statuses
 * - If all items are PROCESSED (RECEIVED, DAMAGED, or NOT_PROCESSED) → status = RECEIVED
 * - If some items are PROCESSED → status = PARTIAL
 * - If all items are NOT_PROCESSED or DAMAGED (and none RECEIVED) → status = CANCELLED
 */
async function updatePurchaseOrderStatusBasedOnItems(purchaseOrderId: string): Promise<void> {
  const purchaseOrder = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    include: { items: true },
  })

  if (!purchaseOrder) return

  const totalItems = purchaseOrder.items.length
  const receivedItems = purchaseOrder.items.filter(i => i.receiveStatus === PurchaseOrderItemStatus.RECEIVED).length
  const notProcessedItems = purchaseOrder.items.filter(i => i.receiveStatus === PurchaseOrderItemStatus.NOT_PROCESSED).length
  const damagedItems = purchaseOrder.items.filter(i => i.receiveStatus === PurchaseOrderItemStatus.DAMAGED).length

  // Count items that have been processed (any status)
  const processedItems = receivedItems + notProcessedItems + damagedItems

  let newStatus = purchaseOrder.status

  // All items have been processed (received, damaged, or not processed)
  if (processedItems === totalItems) {
    // If ALL items are damaged or not processed (none received), mark as CANCELLED
    if (receivedItems === 0 && notProcessedItems + damagedItems === totalItems) {
      newStatus = PurchaseOrderStatus.CANCELLED
    } else {
      // Otherwise, the order is complete (some received, some damaged/not processed)
      newStatus = PurchaseOrderStatus.RECEIVED
    }
  }
  // Some items processed, but not all
  else if (processedItems > 0) {
    newStatus = PurchaseOrderStatus.PARTIAL
  }

  // Update status if changed
  if (newStatus !== purchaseOrder.status) {
    await prisma.purchaseOrder.update({
      where: { id: purchaseOrderId },
      data: { status: newStatus },
    })
  }
}

/**
 * Public function to recalculate and update purchase order status based on item statuses
 * This should be called after batch updates to ensure the order status reflects the latest item states
 */
export async function recalculatePurchaseOrderStatus(venueId: string, purchaseOrderId: string): Promise<void> {
  // Verify the purchase order belongs to the venue
  const purchaseOrder = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId, venueId },
    select: { id: true },
  })

  if (!purchaseOrder) {
    throw new AppError('Purchase order not found', 404)
  }

  await updatePurchaseOrderStatusBasedOnItems(purchaseOrderId)
}

/**
 * Generate labels for purchase order items
 */
export async function generateLabels(
  venueId: string,
  purchaseOrderId: string,
  config: {
    labelType: string
    barcodeFormat: 'SKU' | 'GTIN'
    details: {
      sku: boolean
      gtin: boolean
      variantName: boolean
      price: boolean
      itemName: boolean
      unitAbbr: boolean
    }
    items: Array<{
      itemId: string
      quantity: number
    }>
  },
): Promise<{ pdfBuffer: Buffer; totalLabels: number }> {
  // 1. Fetch purchase order with items
  const purchaseOrder = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId, venueId },
    include: {
      items: {
        include: {
          rawMaterial: true,
        },
      },
    },
  })

  if (!purchaseOrder) {
    throw new AppError('Purchase order not found', 404)
  }

  // 2. Filter and map items according to config
  const selectedItems = purchaseOrder.items
    .filter(item => config.items.some(i => i.itemId === item.id))
    .map(item => {
      const configItem = config.items.find(i => i.itemId === item.id)!
      return {
        ...item,
        labelQuantity: configItem.quantity,
      }
    })

  if (selectedItems.length === 0) {
    throw new AppError('No items selected for label generation', 400)
  }

  // 3. Get label template
  const labelTemplate = getLabelTemplate(config.labelType)

  // 4. Create PDF document
  const doc = new PDFDocument({
    size: labelTemplate.pageSize,
    margin: 0,
  })

  const chunks: Buffer[] = []
  doc.on('data', (chunk: Buffer) => chunks.push(chunk))

  let labelIndex = 0
  let totalLabelsGenerated = 0

  // 5. Generate labels for each item
  for (const item of selectedItems) {
    for (let i = 0; i < item.labelQuantity; i++) {
      // Calculate position on page
      const position = calculateLabelPosition(labelIndex, labelTemplate)

      let yOffset = position.y + 5

      // Generate barcode if SKU is available
      const barcodeData = item.rawMaterial.sku

      if (barcodeData && barcodeData.trim() !== '') {
        try {
          const barcodeFormat = getRecommendedBarcodeFormat(barcodeData)
          const barcodePNG = await generateBarcode({
            code: barcodeData,
            format: barcodeFormat,
            width: Math.floor(labelTemplate.width / 2.83465), // Convert points to mm
            height: 10,
            includeText: true,
          })

          // Add barcode image to label
          doc.image(barcodePNG, position.x + 5, yOffset, {
            fit: [labelTemplate.width - 10, 30],
          })

          yOffset += 35
        } catch (error) {
          logger.error('Error generating barcode:', error)
          // Continue without barcode
        }
      }

      // Add details based on config
      if (config.details.itemName) {
        doc
          .fontSize(8)
          .font('Helvetica-Bold')
          .text(item.rawMaterial.name, position.x + 5, yOffset, {
            width: labelTemplate.width - 10,
            ellipsis: true,
          })
        yOffset += 10
      }

      if (config.details.sku && item.rawMaterial.sku) {
        doc
          .fontSize(7)
          .font('Helvetica')
          .text(`SKU: ${item.rawMaterial.sku}`, position.x + 5, yOffset)
        yOffset += 9
      }

      if (config.details.price) {
        doc
          .fontSize(9)
          .font('Helvetica-Bold')
          .text(`$${item.unitPrice}`, position.x + 5, yOffset)
        yOffset += 10
      }

      if (config.details.unitAbbr && item.rawMaterial.unit) {
        const unitText = getUnitAbbreviation(item.rawMaterial.unit)
        doc
          .fontSize(7)
          .font('Helvetica')
          .text(unitText, position.x + 5, yOffset)
      }

      labelIndex++
      totalLabelsGenerated++

      // Add new page if needed
      if (labelIndex % labelTemplate.labelsPerPage === 0 && i < item.labelQuantity - 1) {
        doc.addPage()
        labelIndex = 0
      }
    }
  }

  // 6. Finalize PDF
  doc.end()

  // 7. Wait for PDF to finish and return buffer
  const pdfBuffer = await new Promise<Buffer>(resolve => {
    doc.on('end', () => {
      resolve(Buffer.concat(chunks))
    })
  })

  return {
    pdfBuffer,
    totalLabels: totalLabelsGenerated,
  }
}

/**
 * Get unit abbreviation for labels
 */
function getUnitAbbreviation(unit: Unit): string {
  const abbreviations: Record<Unit, string> = {
    // Weight units
    GRAM: 'g',
    KILOGRAM: 'kg',
    MILLIGRAM: 'mg',
    POUND: 'lb',
    OUNCE: 'oz',
    TON: 't',
    // Volume units - Liquid
    MILLILITER: 'ml',
    LITER: 'L',
    GALLON: 'gal',
    QUART: 'qt',
    PINT: 'pt',
    CUP: 'cup',
    FLUID_OUNCE: 'fl oz',
    TABLESPOON: 'tbsp',
    TEASPOON: 'tsp',
    // Count units
    UNIT: 'ud',
    PIECE: 'pz',
    DOZEN: 'dz',
    CASE: 'caja',
    BOX: 'caja',
    BAG: 'bolsa',
    BOTTLE: 'bot',
    CAN: 'lata',
    JAR: 'frasco',
    // Length units
    METER: 'm',
    CENTIMETER: 'cm',
    MILLIMETER: 'mm',
    INCH: 'in',
    FOOT: 'ft',
    // Temperature units
    CELSIUS: '°C',
    FAHRENHEIT: '°F',
    // Time units
    MINUTE: 'min',
    HOUR: 'h',
    DAY: 'd',
  }
  return abbreviations[unit] || unit
}

/**
 * Generate PDF document for purchase order
 */
export async function generatePurchaseOrderPDF(venueId: string, purchaseOrderId: string): Promise<Buffer> {
  // Fetch purchase order with all relations
  const purchaseOrder = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId, venueId },
    include: {
      supplier: true,
      venue: true,
      items: {
        include: {
          rawMaterial: true,
        },
      },
    },
  })

  if (!purchaseOrder) {
    throw new AppError('Purchase order not found', 404)
  }

  // Create PDF document
  const doc = new PDFDocument({
    size: 'LETTER',
    margin: 50,
  })

  const chunks: Buffer[] = []
  doc.on('data', (chunk: Buffer) => chunks.push(chunk))

  // Header
  doc.fontSize(20).font('Helvetica-Bold').text('ORDEN DE COMPRA', { align: 'center' })
  doc.moveDown(0.5)

  // Order number and date
  doc.fontSize(10).font('Helvetica')
  doc.text(`Orden #: ${purchaseOrder.orderNumber}`, { align: 'right' })
  doc.text(`Fecha: ${new Date(purchaseOrder.orderDate).toLocaleDateString('es-MX')}`, { align: 'right' })
  if (purchaseOrder.expectedDeliveryDate) {
    doc.text(`Entrega esperada: ${new Date(purchaseOrder.expectedDeliveryDate).toLocaleDateString('es-MX')}`, { align: 'right' })
  }
  doc.text(`Estado: ${purchaseOrder.status}`, { align: 'right' })

  doc.moveDown(1)

  // Two columns: Venue and Supplier
  const leftX = 50
  const rightX = 320

  // Venue info (left column)
  doc.fontSize(12).font('Helvetica-Bold').text('DE:', leftX, doc.y)
  doc.fontSize(10).font('Helvetica')
  doc.text(purchaseOrder.venue.name, leftX, doc.y)
  if (purchaseOrder.venue.address) doc.text(purchaseOrder.venue.address, leftX, doc.y)
  if (purchaseOrder.venue.city && purchaseOrder.venue.state) {
    doc.text(`${purchaseOrder.venue.city}, ${purchaseOrder.venue.state}`, leftX, doc.y)
  }
  if (purchaseOrder.venue.phone) doc.text(`Tel: ${purchaseOrder.venue.phone}`, leftX, doc.y)

  // Supplier info (right column)
  const supplierY = 200
  doc.fontSize(12).font('Helvetica-Bold').text('PARA:', rightX, supplierY)
  doc.fontSize(10).font('Helvetica')
  doc.text(purchaseOrder.supplier.name, rightX, doc.y)
  if (purchaseOrder.supplier.contactName) doc.text(`Contacto: ${purchaseOrder.supplier.contactName}`, rightX, doc.y)
  if (purchaseOrder.supplier.email) doc.text(`Email: ${purchaseOrder.supplier.email}`, rightX, doc.y)
  if (purchaseOrder.supplier.phone) doc.text(`Tel: ${purchaseOrder.supplier.phone}`, rightX, doc.y)
  if (purchaseOrder.supplier.address) doc.text(purchaseOrder.supplier.address, rightX, doc.y)

  doc.moveDown(2)

  // Items table
  const tableTop = doc.y + 20
  const tableHeaders = ['Artículo', 'Cantidad', 'Precio Unit.', 'Total']
  const colWidths = [250, 80, 90, 90]
  const colX = [50, 300, 380, 470]

  // Table header
  doc.fontSize(10).font('Helvetica-Bold')
  tableHeaders.forEach((header, i) => {
    doc.text(header, colX[i], tableTop, { width: colWidths[i], align: i === 0 ? 'left' : 'right' })
  })

  // Horizontal line
  doc
    .moveTo(50, tableTop + 15)
    .lineTo(560, tableTop + 15)
    .stroke()

  // Table rows
  doc.font('Helvetica')
  let yPosition = tableTop + 25

  purchaseOrder.items.forEach(item => {
    const itemTotal = item.quantityOrdered.toNumber() * item.unitPrice.toNumber()

    // Check if we need a new page
    if (yPosition > 700) {
      doc.addPage()
      yPosition = 50
    }

    doc.text(item.rawMaterial.name, colX[0], yPosition, { width: colWidths[0] })
    doc.text(`${item.quantityOrdered} ${getUnitAbbreviation(item.unit)}`, colX[1], yPosition, {
      width: colWidths[1],
      align: 'right',
    })
    doc.text(`$${item.unitPrice.toFixed(2)}`, colX[2], yPosition, { width: colWidths[2], align: 'right' })
    doc.text(`$${itemTotal.toFixed(2)}`, colX[3], yPosition, { width: colWidths[3], align: 'right' })

    yPosition += 20
  })

  // Summary section
  yPosition += 20

  // Horizontal line
  doc.moveTo(380, yPosition).lineTo(560, yPosition).stroke()

  yPosition += 15

  // Subtotal
  doc.font('Helvetica')
  doc.text('Subtotal:', 380, yPosition)
  doc.text(`$${purchaseOrder.subtotal.toFixed(2)}`, 470, yPosition, { width: 90, align: 'right' })
  yPosition += 20

  // Tax
  if (purchaseOrder.taxAmount && purchaseOrder.taxAmount.toNumber() > 0) {
    doc.text(`IVA (${purchaseOrder.taxRate.toNumber()}%):`, 380, yPosition)
    doc.text(`$${purchaseOrder.taxAmount.toFixed(2)}`, 470, yPosition, { width: 90, align: 'right' })
    yPosition += 20
  }

  // Commission
  if (purchaseOrder.commission && purchaseOrder.commission.toNumber() > 0) {
    doc.text(`Comisión (${purchaseOrder.commissionRate.toNumber()}%):`, 380, yPosition)
    doc.text(`$${purchaseOrder.commission.toFixed(2)}`, 470, yPosition, { width: 90, align: 'right' })
    yPosition += 20
  }

  // Total
  doc.fontSize(12).font('Helvetica-Bold')
  doc.text('TOTAL:', 380, yPosition)
  doc.text(`$${purchaseOrder.total.toFixed(2)}`, 470, yPosition, { width: 90, align: 'right' })

  // Notes
  if (purchaseOrder.notes) {
    yPosition += 40
    if (yPosition > 650) {
      doc.addPage()
      yPosition = 50
    }

    doc.fontSize(10).font('Helvetica-Bold').text('NOTAS:', 50, yPosition)
    yPosition += 15
    doc.fontSize(9).font('Helvetica').text(purchaseOrder.notes, 50, yPosition, { width: 500 })
  }

  // Footer
  const footerY = 720
  doc.fontSize(8).font('Helvetica').text('Generado por Avoqado', 50, footerY, { align: 'center', width: 500 })
  doc.text(`Fecha de generación: ${new Date().toLocaleDateString('es-MX')}`, 50, footerY + 10, {
    align: 'center',
    width: 500,
  })

  // Finalize PDF
  doc.end()

  // Wait for PDF to finish and return buffer
  const pdfBuffer = await new Promise<Buffer>(resolve => {
    doc.on('end', () => {
      resolve(Buffer.concat(chunks))
    })
  })

  return pdfBuffer
}
