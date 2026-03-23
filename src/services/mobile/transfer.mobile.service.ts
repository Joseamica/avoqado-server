/**
 * Mobile Inventory Transfer Service
 *
 * Inventory transfer management between locations for iOS/Android POS apps.
 * Uses the InventoryTransfer model with JSON items.
 */

import prisma from '../../utils/prismaClient'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import { logAction } from '../dashboard/activity-log.service'

// ============================================================================
// LIST TRANSFERS
// ============================================================================

/**
 * List inventory transfers for a venue.
 */
export async function listTransfers(venueId: string, page: number, pageSize: number) {
  const skip = (page - 1) * pageSize

  const [transfers, total] = await Promise.all([
    prisma.inventoryTransfer.findMany({
      where: { venueId },
      orderBy: { createdAt: 'desc' },
      skip,
      take: pageSize,
    }),
    prisma.inventoryTransfer.count({ where: { venueId } }),
  ])

  return {
    transfers: transfers.map(formatTransfer),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  }
}

// ============================================================================
// GET TRANSFER DETAIL
// ============================================================================

/**
 * Get a single transfer with details.
 */
export async function getTransfer(transferId: string, venueId: string) {
  const transfer = await prisma.inventoryTransfer.findFirst({
    where: { id: transferId, venueId },
  })

  if (!transfer) {
    throw new NotFoundError('Transferencia no encontrada')
  }

  return formatTransfer(transfer)
}

// ============================================================================
// CREATE TRANSFER
// ============================================================================

interface TransferItem {
  productId: string
  productName: string
  quantity: number
}

interface CreateTransferParams {
  venueId: string
  staffId: string
  staffName: string
  fromLocationName: string
  toLocationName: string
  items: TransferItem[]
  notes?: string
}

/**
 * Create a new inventory transfer.
 */
export async function createTransfer(params: CreateTransferParams) {
  const { venueId, staffId, staffName, fromLocationName, toLocationName, items, notes } = params

  if (!fromLocationName || !toLocationName) {
    throw new BadRequestError('fromLocationName y toLocationName son requeridos')
  }

  if (!items || items.length === 0) {
    throw new BadRequestError('Se requiere al menos un producto')
  }

  const transfer = await prisma.inventoryTransfer.create({
    data: {
      venueId,
      fromLocationName: fromLocationName.trim(),
      toLocationName: toLocationName.trim(),
      status: 'DRAFT',
      notes: notes || null,
      itemsJson: JSON.stringify(items),
      createdById: staffId,
      createdByName: staffName,
    },
  })

  logAction({
    staffId,
    venueId,
    action: 'INVENTORY_TRANSFER_CREATED',
    entity: 'InventoryTransfer',
    entityId: transfer.id,
    data: {
      from: fromLocationName,
      to: toLocationName,
      itemCount: items.length,
      source: 'MOBILE',
    },
  })

  return formatTransfer(transfer)
}

// ============================================================================
// UPDATE STATUS
// ============================================================================

const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['IN_TRANSIT', 'CANCELLED'],
  IN_TRANSIT: ['COMPLETED', 'CANCELLED'],
}

/**
 * Update the status of an inventory transfer.
 */
export async function updateStatus(transferId: string, venueId: string, newStatus: string, staffId: string) {
  const transfer = await prisma.inventoryTransfer.findFirst({
    where: { id: transferId, venueId },
  })

  if (!transfer) {
    throw new NotFoundError('Transferencia no encontrada')
  }

  const allowed = VALID_TRANSITIONS[transfer.status] || []
  if (!allowed.includes(newStatus)) {
    throw new BadRequestError(`No se puede cambiar de ${transfer.status} a ${newStatus}`)
  }

  const updated = await prisma.inventoryTransfer.update({
    where: { id: transferId },
    data: { status: newStatus as any },
  })

  // If completing the transfer, create inventory movements
  if (newStatus === 'COMPLETED' && transfer.itemsJson) {
    try {
      const items: TransferItem[] = JSON.parse(transfer.itemsJson)
      for (const item of items) {
        // Find product inventory
        const inventory = await prisma.inventory.findFirst({
          where: {
            product: { id: item.productId, venueId },
          },
        })

        if (inventory) {
          const previousStock = Number(inventory.currentStock)
          // For transfers, the source location loses stock
          // In a single-venue model this is tracked as metadata
          await prisma.inventoryMovement.create({
            data: {
              inventoryId: inventory.id,
              type: 'TRANSFER',
              quantity: item.quantity,
              previousStock,
              newStock: previousStock, // Stock stays same in single-venue (metadata only)
              reason: `Transferencia de ${transfer.fromLocationName} a ${transfer.toLocationName}`,
              reference: transfer.id,
              createdBy: staffId,
            },
          })
        }
      }
    } catch {
      // If JSON parsing fails, skip inventory movements
    }
  }

  logAction({
    staffId,
    venueId,
    action: 'INVENTORY_TRANSFER_STATUS_UPDATED',
    entity: 'InventoryTransfer',
    entityId: transfer.id,
    data: { from: transfer.status, to: newStatus, source: 'MOBILE' },
  })

  return formatTransfer(updated)
}

// ============================================================================
// HELPERS
// ============================================================================

function formatTransfer(transfer: any) {
  let items: any[] = []
  if (transfer.itemsJson) {
    try {
      items = JSON.parse(transfer.itemsJson)
    } catch {
      items = []
    }
  }

  return {
    id: transfer.id,
    venueId: transfer.venueId,
    fromLocationName: transfer.fromLocationName,
    toLocationName: transfer.toLocationName,
    status: transfer.status,
    notes: transfer.notes,
    items,
    createdById: transfer.createdById,
    createdByName: transfer.createdByName,
    createdAt: transfer.createdAt.toISOString(),
    updatedAt: transfer.updatedAt.toISOString(),
  }
}
