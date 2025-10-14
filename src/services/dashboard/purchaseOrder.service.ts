import { PurchaseOrder, PurchaseOrderStatus, RawMaterialMovementType, Prisma, Unit } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import AppError from '../../errors/AppError'
import { CreatePurchaseOrderDto, UpdatePurchaseOrderDto, ReceivePurchaseOrderDto } from '../../schemas/dashboard/inventory.schema'
import { Decimal } from '@prisma/client/runtime/library'
import { createStockBatch } from './fifoBatch.service'

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

  return purchaseOrder as any
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

  const taxAmount = subtotal.mul(data.taxRate || 0.16)
  const totalAmount = subtotal.add(taxAmount)

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
      taxRate: data.taxRate || 0.16,
      taxAmount,
      total: totalAmount,
      notes: data.notes,
      createdBy: staffId,
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

  // Prevent editing received orders
  if (existingOrder.status === PurchaseOrderStatus.RECEIVED) {
    throw new AppError(`Cannot edit purchase order with status ${existingOrder.status}`, 400)
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

  // Check if order is fully received
  const allItemsReceived = order.items.every(item => {
    const receivedQty = data.items.find(ri => ri.purchaseOrderItemId === item.id)?.quantityReceived || 0
    const totalReceived = item.quantityReceived.add(receivedQty)
    return totalReceived.equals(item.quantityOrdered)
  })

  const newStatus = allItemsReceived ? PurchaseOrderStatus.RECEIVED : PurchaseOrderStatus.PARTIAL

  // Update purchase order status
  operations.push(
    prisma.purchaseOrder.update({
      where: { id: purchaseOrderId },
      data: {
        status: newStatus,
        receivedDate: new Date(data.receivedDate),
        receivedBy: staffId,
      },
    }),
  )

  // Execute all operations in a transaction
  await prisma.$transaction(operations)

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
