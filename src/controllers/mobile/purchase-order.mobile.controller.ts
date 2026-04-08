/**
 * Mobile Purchase Order Controller
 *
 * Handles purchase order management for POS mobile apps.
 */

import { NextFunction, Request, Response } from 'express'
import * as poService from '../../services/mobile/purchase-order.mobile.service'

/**
 * List purchase orders
 * @route GET /api/v1/mobile/venues/:venueId/purchase-orders
 */
export const listPurchaseOrders = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const page = parseInt(req.query.page as string) || 1
    const pageSize = Math.min(parseInt(req.query.pageSize as string) || 20, 50)

    const filters: poService.ListPOFilters = {}
    if (req.query.status) filters.status = req.query.status as string
    if (req.query.dateFrom) filters.dateFrom = req.query.dateFrom as string
    if (req.query.dateTo) filters.dateTo = req.query.dateTo as string
    if (req.query.search) filters.search = req.query.search as string

    const result = await poService.listPurchaseOrders(venueId, page, pageSize, filters)

    return res.json({ success: true, ...result })
  } catch (error) {
    next(error)
  }
}

/**
 * Create purchase order
 * @route POST /api/v1/mobile/venues/:venueId/purchase-orders
 *
 * BUG FIX (Bug 1): Android client sends items with field names:
 *   { productId, productName, orderedQuantity, unitCost }
 * But the service internally expects:
 *   { rawMaterialId, quantity, unitPrice (cents), unit, notes }
 * The controller must translate between the mobile API contract and the
 * internal service contract. We accept BOTH old and new field names for
 * backward compatibility with existing clients (e.g. iOS).
 *
 * Also note: Android sends `expectedDeliveryDate` whereas older clients may
 * send `expectedDate`. Accept both.
 */
export const createPurchaseOrder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const staffId = req.authContext?.userId || ''
    // Accept both `expectedDeliveryDate` (Android) and `expectedDate` (legacy)
    const { supplierName, items, notes } = req.body
    const expectedDate = req.body.expectedDeliveryDate || req.body.expectedDate

    if (!supplierName) {
      return res.status(400).json({ success: false, message: 'supplierName es requerido' })
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Se requiere al menos un producto (items)' })
    }

    // Map Android client field names to backend service field names.
    // Android sends: { productId, productName, orderedQuantity, unitCost (decimal dollars) }
    // Service expects: { rawMaterialId, quantity, unitPrice (integer cents), unit, notes }
    // The service has logic to resolve a Product ID into a RawMaterial automatically
    // (see purchase-order.mobile.service.ts lines 161-204).
    const mappedItems = items.map((item: any) => {
      // Prefer rawMaterialId if provided (legacy), else fall back to productId (Android)
      const rawMaterialId = item.rawMaterialId || item.productId

      // Prefer explicit `quantity` if provided, else use `orderedQuantity` (Android)
      const quantity = item.quantity ?? item.orderedQuantity ?? 1

      // Unit price in cents. Accept either:
      //   - `unitPrice` (integer cents, legacy/iOS)
      //   - `unitCost` (decimal dollars, Android) → convert to cents
      let unitPrice = 0
      if (item.unitPrice != null) {
        unitPrice = Number(item.unitPrice)
      } else if (item.unitCost != null) {
        unitPrice = Math.round(Number(item.unitCost) * 100)
      }

      return {
        rawMaterialId,
        quantity,
        unitPrice,
        unit: item.unit || 'PIECE',
        notes: item.notes || null,
      }
    })

    const result = await poService.createPurchaseOrder({
      venueId,
      staffId,
      supplierName,
      items: mappedItems,
      notes,
      expectedDate,
    })

    return res.status(201).json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}

/**
 * Get purchase order detail
 * @route GET /api/v1/mobile/venues/:venueId/purchase-orders/:poId
 */
export const getPurchaseOrder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, poId } = req.params

    const result = await poService.getPurchaseOrder(poId, venueId)

    return res.json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}

/**
 * Update purchase order status
 * @route PUT /api/v1/mobile/venues/:venueId/purchase-orders/:poId/status
 */
export const updateStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, poId } = req.params
    const staffId = req.authContext?.userId || ''
    const { status } = req.body

    if (!status) {
      return res.status(400).json({ success: false, message: 'status es requerido' })
    }

    const result = await poService.updateStatus(poId, venueId, status, staffId)

    return res.json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}

/**
 * Receive stock from purchase order
 * @route POST /api/v1/mobile/venues/:venueId/purchase-orders/:poId/receive
 *
 * BUG FIX (Bug 2): Android client sends receive items with field names:
 *   { items: [{ purchaseOrderItemId, receivedQuantity }] }
 * But the service internally expects:
 *   { items: [{ itemId, receivedQuantity }] }
 * The controller must translate between the mobile API contract and the
 * internal service contract. We accept BOTH old and new field names for
 * backward compatibility, preferring `purchaseOrderItemId` (the more
 * descriptive name used by the Android client) when both are present.
 */
export const receiveStock = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, poId } = req.params
    const staffId = req.authContext?.userId || ''
    const { items } = req.body

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Se requiere al menos un item (items)' })
    }

    // Map Android field name `purchaseOrderItemId` → service field `itemId`.
    // Prefer `purchaseOrderItemId` if both are provided (matches the mobile
    // contract); fall back to `itemId` for legacy clients.
    const mappedItems = items.map((item: any) => ({
      itemId: item.purchaseOrderItemId || item.itemId,
      receivedQuantity: Number(item.receivedQuantity) || 0,
    }))

    const result = await poService.receiveStock(poId, venueId, mappedItems, staffId)

    return res.json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}
