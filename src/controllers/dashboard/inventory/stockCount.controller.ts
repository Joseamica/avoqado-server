/**
 * Dashboard Stock Count Controller (READ-ONLY)
 *
 * Exposes stock counts to the web dashboard for auditing purposes.
 * Stock counts are created by the mobile POS apps (iOS/Android) — this
 * controller intentionally provides only read endpoints so accountants
 * and managers can review the history from the dashboard.
 *
 * Reuses the mobile inventory service to keep the data-shape consistent
 * between mobile and dashboard consumers.
 */

import { Request, Response, NextFunction } from 'express'
import * as inventoryMobileService from '../../../services/mobile/inventory.mobile.service'

/**
 * GET /api/v1/dashboard/venues/:venueId/inventory/stock-counts
 *
 * List stock counts for a venue with optional filters.
 * Query params:
 *   - status: 'IN_PROGRESS' | 'COMPLETED'
 *   - type: 'CYCLE' | 'FULL'
 *   - startDate, endDate: ISO date strings (filters by createdAt)
 *   - page, pageSize: pagination (defaults: 1, 50)
 */
export async function listStockCounts(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { status, type, startDate, endDate, page, pageSize } = req.query

    // Reuse mobile service (returns all counts sorted desc by createdAt)
    const allCounts = await inventoryMobileService.getStockCounts(venueId)

    // Apply filters
    let filtered = allCounts
    if (status) {
      filtered = filtered.filter(c => c.status === status)
    }
    if (type) {
      filtered = filtered.filter(c => c.type === type)
    }
    if (startDate) {
      const start = new Date(startDate as string)
      filtered = filtered.filter(c => new Date(c.createdAt) >= start)
    }
    if (endDate) {
      const end = new Date(endDate as string)
      end.setHours(23, 59, 59, 999)
      filtered = filtered.filter(c => new Date(c.createdAt) <= end)
    }

    // Pagination
    const pageNum = Math.max(1, parseInt((page as string) || '1', 10))
    const size = Math.min(200, Math.max(1, parseInt((pageSize as string) || '50', 10)))
    const total = filtered.length
    const start = (pageNum - 1) * size
    const paged = filtered.slice(start, start + size)

    // Include summary diff for list view (without the heavy items array per row)
    const rows = paged.map(c => {
      const totalDifference = c.items.reduce((sum, it) => sum + it.difference, 0)
      return {
        id: c.id,
        type: c.type,
        status: c.status,
        note: c.note,
        createdAt: c.createdAt,
        createdBy: c.createdBy,
        itemCount: c.itemCount,
        totalDifference,
      }
    })

    res.json({
      success: true,
      data: rows,
      pagination: {
        page: pageNum,
        pageSize: size,
        total,
        totalPages: Math.ceil(total / size),
      },
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/inventory/stock-counts/:countId
 *
 * Get a single stock count with its full item list.
 */
export async function getStockCount(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, countId } = req.params

    const allCounts = await inventoryMobileService.getStockCounts(venueId)
    const count = allCounts.find(c => c.id === countId)

    if (!count) {
      return res.status(404).json({
        success: false,
        message: 'Conteo no encontrado',
      })
    }

    res.json({
      success: true,
      data: count,
    })
  } catch (error) {
    next(error)
  }
}
