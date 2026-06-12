/**
 * Inventory restock on refund — shared by dashboard and TPV refund flows.
 *
 * Extracted from `refund.dashboard.service.ts` so the TPV refund path
 * (`recordRefund` in `src/services/tpv/refund.tpv.service.ts`) restocks
 * inventory with EXACTLY the same semantics — no drift between the two refund
 * entry points. Both ultimately call `adjustStock`, which keeps the FIFO
 * invariant (`RawMaterial.currentStock === Σ active StockBatch.remainingQuantity`)
 * consistent by creating a new batch + incrementing the aggregate atomically.
 */
import { MovementType, Prisma, RawMaterialMovementType } from '@prisma/client'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { adjustStock } from './rawMaterial.service'

/**
 * Add stock back for a single refunded item.
 *
 * Routes by inventoryMethod:
 *   - QUANTITY: atomic increment on the product's `Inventory` row + ADJUSTMENT
 *     movement.
 *   - RECIPE:   for each recipe line (skipping optional/variable lines), call
 *     `adjustStock` on the raw material with `quantity * portions`. This
 *     creates a new batch at current cost and an ADJUSTMENT movement. Note
 *     this is an approximation — FIFO batches consumed during the original
 *     sale aren't tracked back to their exact origin.
 *
 *     Modifier substitutions (SUBSTITUTION mode) are *not* reversed here —
 *     the default recipe ingredients are the ones restocked.
 *
 * No-op for products that don't track inventory or use serialized inventory.
 */
export async function restockItem(args: {
  venueId: string
  productId: string
  quantity: number
  refundPaymentId: string
  staffId?: string
  /** Override del motivo del movimiento (p.ej. reversa por rollback de pago). */
  reason?: string
}) {
  const { venueId, productId, quantity, refundPaymentId, staffId } = args

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, name: true, inventoryMethod: true, trackInventory: true },
  })
  if (!product || !product.trackInventory) return

  // Explicit QUANTITY, or fall back: if an Inventory row exists, treat as QUANTITY.
  const method = product.inventoryMethod
  if (method === 'QUANTITY') {
    const inventory = await prisma.inventory.findUnique({ where: { productId } })
    if (!inventory) return
    await prisma.$transaction(async tx => {
      const updated = await tx.inventory.update({
        where: { productId },
        data: { currentStock: { increment: quantity } },
      })
      const newStock = updated.currentStock
      const previousStock = newStock.sub(quantity)
      await tx.inventoryMovement.create({
        data: {
          inventoryId: inventory.id,
          type: MovementType.ADJUSTMENT,
          quantity: new Prisma.Decimal(quantity),
          previousStock,
          newStock,
          reason: args.reason ?? `Refund restock (paymentId=${refundPaymentId})`,
          reference: refundPaymentId,
          createdBy: staffId,
        },
      })
    })
    logger.info('[INVENTORY RESTOCK] Restocked (QUANTITY)', { venueId, productId, quantity, refundPaymentId })
    return
  }

  if (method === 'RECIPE') {
    const recipe = await prisma.recipe.findUnique({
      where: { productId },
      include: { lines: { include: { rawMaterial: { select: { id: true, name: true, unit: true } } } } },
    })
    if (!recipe) return

    for (const line of recipe.lines) {
      if (line.isOptional) continue
      // Skip variable (substitution-capable) lines — we can't know without the
      // original OrderItemModifier set whether the default or substitute was used.
      if (line.isVariable) continue

      const addQty = Number(line.quantity) * quantity
      if (addQty <= 0) continue

      try {
        await adjustStock(
          venueId,
          line.rawMaterialId,
          {
            quantity: addQty,
            type: RawMaterialMovementType.ADJUSTMENT,
            reason: args.reason ?? `Refund restock for ${product.name} (paymentId=${refundPaymentId})`,
            reference: refundPaymentId,
          },
          staffId,
        )
      } catch (err: any) {
        logger.warn('[INVENTORY RESTOCK] Failed to restock raw material', {
          rawMaterialId: line.rawMaterialId,
          productId,
          addQty,
          error: err?.message ?? err,
        })
      }
    }
    logger.info('[INVENTORY RESTOCK] Restocked (RECIPE)', {
      venueId,
      productId,
      portions: quantity,
      lines: recipe.lines.length,
      refundPaymentId,
    })
    return
  }

  logger.info('[INVENTORY RESTOCK] Skipped restock (no inventoryMethod)', { productId })
}

/**
 * Restock every inventory-tracked item of an order — used when an order is
 * fully refunded and there is no per-item breakdown (e.g. TPV amount-based
 * refunds). Restocks the full original quantity of each OrderItem.
 *
 * Best-effort per item: a single item's failure is logged and skipped, never
 * thrown, so the caller's refund is never rolled back. Serialized-inventory
 * items and products without inventory tracking are skipped by `restockItem`.
 */
export async function restockOrderItems(args: { venueId: string; orderId: string; refundPaymentId: string; staffId?: string }) {
  const { venueId, orderId, refundPaymentId, staffId } = args

  const items = await prisma.orderItem.findMany({
    where: { orderId, productId: { not: null } },
    select: { id: true, productId: true, quantity: true },
  })

  let restocked = 0
  for (const item of items) {
    if (!item.productId || item.quantity <= 0) continue
    try {
      await restockItem({ venueId, productId: item.productId, quantity: item.quantity, refundPaymentId, staffId })
      restocked++
    } catch (err: any) {
      logger.warn('[INVENTORY RESTOCK] Failed to restock order item', {
        orderId,
        orderItemId: item.id,
        productId: item.productId,
        error: err?.message ?? err,
      })
    }
  }

  logger.info('[INVENTORY RESTOCK] Restocked order items', { venueId, orderId, refundPaymentId, items: items.length, restocked })
  return { items: items.length, restocked }
}
