import { PurchaseOrderStatus } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import AppError from '../../errors/AppError'
import { logAction } from './activity-log.service'

/**
 * Valid state transitions for Purchase Orders
 * Key: current status -> Value: array of allowed next statuses
 */
const VALID_TRANSITIONS: Record<PurchaseOrderStatus, PurchaseOrderStatus[]> = {
  [PurchaseOrderStatus.DRAFT]: [
    PurchaseOrderStatus.PENDING_APPROVAL, // Submit for approval
    PurchaseOrderStatus.APPROVED, // Direct approval (for small orders)
    PurchaseOrderStatus.CANCELLED, // Cancel before submitting
  ],
  [PurchaseOrderStatus.PENDING_APPROVAL]: [
    PurchaseOrderStatus.APPROVED, // Approved by manager
    PurchaseOrderStatus.REJECTED, // Rejected by manager
    PurchaseOrderStatus.CANCELLED, // Cancelled while pending
  ],
  [PurchaseOrderStatus.REJECTED]: [
    PurchaseOrderStatus.DRAFT, // Back to draft to fix issues
    PurchaseOrderStatus.CANCELLED, // Cancel permanently
  ],
  [PurchaseOrderStatus.APPROVED]: [
    PurchaseOrderStatus.SENT, // Send to supplier
    PurchaseOrderStatus.CANCELLED, // Cancel before sending
  ],
  [PurchaseOrderStatus.SENT]: [
    PurchaseOrderStatus.CONFIRMED, // Supplier confirms
    PurchaseOrderStatus.CANCELLED, // Cancel if supplier rejects
  ],
  [PurchaseOrderStatus.CONFIRMED]: [
    PurchaseOrderStatus.SHIPPED, // Supplier ships
    PurchaseOrderStatus.PARTIAL, // Partial shipment received
    PurchaseOrderStatus.RECEIVED, // Full shipment received directly
    PurchaseOrderStatus.CANCELLED, // Order cancelled by supplier
  ],
  [PurchaseOrderStatus.SHIPPED]: [
    PurchaseOrderStatus.PARTIAL, // Partially received
    PurchaseOrderStatus.RECEIVED, // Fully received
  ],
  [PurchaseOrderStatus.PARTIAL]: [
    PurchaseOrderStatus.RECEIVED, // All items finally received
    PurchaseOrderStatus.CANCELLED, // Cancel remaining items
  ],
  [PurchaseOrderStatus.RECEIVED]: [
    // Terminal state - no transitions allowed
  ],
  [PurchaseOrderStatus.CANCELLED]: [
    // Terminal state - no transitions allowed
  ],
}

/**
 * Check if a status transition is valid
 */
export function isValidTransition(currentStatus: PurchaseOrderStatus, newStatus: PurchaseOrderStatus): boolean {
  const allowedTransitions = VALID_TRANSITIONS[currentStatus]
  return allowedTransitions.includes(newStatus)
}

/**
 * Get all valid next statuses for a given current status
 */
export function getValidNextStatuses(currentStatus: PurchaseOrderStatus): PurchaseOrderStatus[] {
  return VALID_TRANSITIONS[currentStatus] || []
}

/**
 * Submit purchase order for approval
 */
export async function submitForApproval(venueId: string, purchaseOrderId: string, _staffId?: string) {
  const order = await prisma.purchaseOrder.findFirst({
    where: { id: purchaseOrderId, venueId },
  })

  if (!order) {
    throw new AppError('Purchase order not found', 404)
  }

  if (order.status !== PurchaseOrderStatus.DRAFT) {
    throw new AppError(`Cannot submit order with status ${order.status} for approval`, 400)
  }

  // Validate order has items
  const itemCount = await prisma.purchaseOrderItem.count({
    where: { purchaseOrderId },
  })

  if (itemCount === 0) {
    throw new AppError('Cannot submit purchase order without items', 400)
  }

  const result = await prisma.purchaseOrder.update({
    where: { id: purchaseOrderId },
    data: {
      status: PurchaseOrderStatus.PENDING_APPROVAL,
      approvedBy: null,
      approvedAt: null,
      rejectedBy: null,
      rejectedAt: null,
      rejectionReason: null,
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

  logAction({
    staffId: _staffId,
    venueId,
    action: 'PURCHASE_ORDER_SUBMITTED',
    entity: 'PurchaseOrder',
    entityId: purchaseOrderId,
    data: { status: 'PENDING_APPROVAL' },
  })

  return result
}

/**
 * Approve purchase order
 */
export async function approvePurchaseOrder(venueId: string, purchaseOrderId: string, staffId?: string, autoSend = false) {
  const order = await prisma.purchaseOrder.findFirst({
    where: { id: purchaseOrderId, venueId },
  })

  if (!order) {
    throw new AppError('Purchase order not found', 404)
  }

  const allowedStatuses = [PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.PENDING_APPROVAL] as PurchaseOrderStatus[]
  if (!allowedStatuses.includes(order.status)) {
    throw new AppError(`Cannot approve order with status ${order.status}`, 400)
  }

  const updatedOrder = await prisma.purchaseOrder.update({
    where: { id: purchaseOrderId },
    data: {
      status: autoSend ? PurchaseOrderStatus.SENT : PurchaseOrderStatus.APPROVED,
      approvedBy: staffId,
      approvedAt: new Date(),
      rejectedBy: null,
      rejectedAt: null,
      rejectionReason: null,
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

  logAction({
    staffId,
    venueId,
    action: 'PURCHASE_ORDER_APPROVED',
    entity: 'PurchaseOrder',
    entityId: purchaseOrderId,
    data: { autoSend },
  })

  return updatedOrder
}

/**
 * Reject purchase order
 */
export async function rejectPurchaseOrder(venueId: string, purchaseOrderId: string, reason: string, staffId?: string) {
  const order = await prisma.purchaseOrder.findFirst({
    where: { id: purchaseOrderId, venueId },
  })

  if (!order) {
    throw new AppError('Purchase order not found', 404)
  }

  if (order.status !== PurchaseOrderStatus.PENDING_APPROVAL) {
    throw new AppError(`Cannot reject order with status ${order.status}`, 400)
  }

  if (!reason || reason.trim().length === 0) {
    throw new AppError('Rejection reason is required', 400)
  }

  const result = await prisma.purchaseOrder.update({
    where: { id: purchaseOrderId },
    data: {
      status: PurchaseOrderStatus.REJECTED,
      rejectedBy: staffId,
      rejectedAt: new Date(),
      rejectionReason: reason,
      approvedBy: null,
      approvedAt: null,
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

  logAction({
    staffId,
    venueId,
    action: 'PURCHASE_ORDER_REJECTED',
    entity: 'PurchaseOrder',
    entityId: purchaseOrderId,
    data: { reason },
  })

  return result
}

/**
 * Send purchase order to supplier
 */
export async function sendToSupplier(venueId: string, purchaseOrderId: string) {
  const order = await prisma.purchaseOrder.findFirst({
    where: { id: purchaseOrderId, venueId },
  })

  if (!order) {
    throw new AppError('Purchase order not found', 404)
  }

  if (order.status !== PurchaseOrderStatus.APPROVED) {
    throw new AppError(`Cannot send order with status ${order.status}. Order must be approved first.`, 400)
  }

  return prisma.purchaseOrder.update({
    where: { id: purchaseOrderId },
    data: {
      status: PurchaseOrderStatus.SENT,
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
}

/**
 * Mark order as confirmed by supplier
 */
export async function confirmBySupplier(venueId: string, purchaseOrderId: string) {
  const order = await prisma.purchaseOrder.findFirst({
    where: { id: purchaseOrderId, venueId },
  })

  if (!order) {
    throw new AppError('Purchase order not found', 404)
  }

  if (order.status !== PurchaseOrderStatus.SENT) {
    throw new AppError(`Cannot confirm order with status ${order.status}`, 400)
  }

  return prisma.purchaseOrder.update({
    where: { id: purchaseOrderId },
    data: {
      status: PurchaseOrderStatus.CONFIRMED,
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
}

/**
 * Mark order as shipped
 */
export async function markAsShipped(venueId: string, purchaseOrderId: string, trackingNumber?: string) {
  const order = await prisma.purchaseOrder.findFirst({
    where: { id: purchaseOrderId, venueId },
  })

  if (!order) {
    throw new AppError('Purchase order not found', 404)
  }

  if (order.status !== PurchaseOrderStatus.CONFIRMED) {
    throw new AppError(`Cannot mark order as shipped with status ${order.status}`, 400)
  }

  const updateData: any = {
    status: PurchaseOrderStatus.SHIPPED,
  }

  if (trackingNumber) {
    updateData.notes = order.notes ? `${order.notes}\nTracking: ${trackingNumber}` : `Tracking: ${trackingNumber}`
  }

  return prisma.purchaseOrder.update({
    where: { id: purchaseOrderId },
    data: updateData,
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
 * Transition to a specific status with validation
 */
export async function transitionToStatus(
  venueId: string,
  purchaseOrderId: string,
  newStatus: PurchaseOrderStatus,
  metadata?: {
    staffId?: string
    reason?: string
    notes?: string
  },
) {
  const order = await prisma.purchaseOrder.findFirst({
    where: { id: purchaseOrderId, venueId },
  })

  if (!order) {
    throw new AppError('Purchase order not found', 404)
  }

  // Validate transition
  if (!isValidTransition(order.status, newStatus)) {
    const validNext = getValidNextStatuses(order.status)
    throw new AppError(`Invalid status transition from ${order.status} to ${newStatus}. Valid transitions: ${validNext.join(', ')}`, 400)
  }

  // Build update data based on new status
  const updateData: any = {
    status: newStatus,
  }

  // Handle status-specific updates
  switch (newStatus) {
    case PurchaseOrderStatus.APPROVED:
      updateData.approvedBy = metadata?.staffId
      updateData.approvedAt = new Date()
      updateData.rejectedBy = null
      updateData.rejectedAt = null
      updateData.rejectionReason = null
      break

    case PurchaseOrderStatus.REJECTED:
      updateData.rejectedBy = metadata?.staffId
      updateData.rejectedAt = new Date()
      updateData.rejectionReason = metadata?.reason || 'No reason provided'
      updateData.approvedBy = null
      updateData.approvedAt = null
      break

    case PurchaseOrderStatus.CANCELLED:
      if (metadata?.reason) {
        updateData.notes = order.notes ? `${order.notes}\nCancelled: ${metadata.reason}` : `Cancelled: ${metadata.reason}`
      }
      break
  }

  if (metadata?.notes) {
    updateData.notes = order.notes ? `${order.notes}\n${metadata.notes}` : metadata.notes
  }

  const result = await prisma.purchaseOrder.update({
    where: { id: purchaseOrderId },
    data: updateData,
    include: {
      supplier: true,
      items: {
        include: {
          rawMaterial: true,
        },
      },
    },
  })

  logAction({
    staffId: metadata?.staffId,
    venueId,
    action: `PURCHASE_ORDER_${newStatus}`,
    entity: 'PurchaseOrder',
    entityId: purchaseOrderId,
    data: { from: order.status, to: newStatus, reason: metadata?.reason },
  })

  return result
}

/**
 * Get purchase order workflow history
 */
export async function getWorkflowHistory(purchaseOrderId: string) {
  const order = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    select: {
      status: true,
      createdBy: true,
      createdAt: true,
      approvedBy: true,
      approvedAt: true,
      rejectedBy: true,
      rejectedAt: true,
      rejectionReason: true,
      receivedBy: true,
      receivedDate: true,
    },
  })

  if (!order) {
    throw new AppError('Purchase order not found', 404)
  }

  const history: Array<{
    status: string
    timestamp: Date
    staffId?: string
    notes?: string
  }> = []

  // Created
  history.push({
    status: 'DRAFT',
    timestamp: order.createdAt,
    staffId: order.createdBy || undefined,
  })

  // Approved
  if (order.approvedAt) {
    history.push({
      status: 'APPROVED',
      timestamp: order.approvedAt,
      staffId: order.approvedBy || undefined,
    })
  }

  // Rejected
  if (order.rejectedAt) {
    history.push({
      status: 'REJECTED',
      timestamp: order.rejectedAt,
      staffId: order.rejectedBy || undefined,
      notes: order.rejectionReason || undefined,
    })
  }

  // Received
  if (order.receivedDate) {
    history.push({
      status: 'RECEIVED',
      timestamp: order.receivedDate,
      staffId: order.receivedBy || undefined,
    })
  }

  // Sort by timestamp
  history.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())

  return {
    currentStatus: order.status,
    history,
    validNextStatuses: getValidNextStatuses(order.status),
  }
}
