/**
 * Dashboard Inventory Transfer Controller (READ-ONLY)
 *
 * Exposes inventory transfers to the web dashboard for auditing purposes.
 * Transfers are created by the mobile POS apps — this controller provides
 * only read endpoints so accountants and managers can review the history.
 *
 * Reuses the mobile transfer service to keep data shapes consistent.
 */

import { Request, Response, NextFunction } from 'express'
import * as transferMobileService from '../../../services/mobile/transfer.mobile.service'

/**
 * GET /api/v1/dashboard/venues/:venueId/inventory/transfers
 *
 * List inventory transfers for a venue with optional filters.
 * Query params:
 *   - status: 'DRAFT' | 'IN_TRANSIT' | 'COMPLETED' | 'CANCELLED'
 *   - search: string (matches fromLocationName, toLocationName, createdByName)
 *   - startDate, endDate: ISO date strings (filters by createdAt)
 *   - page, pageSize: pagination (defaults: 1, 50)
 */
export async function listTransfers(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { status, search, startDate, endDate, page, pageSize } = req.query

    // Fetch a large page from the mobile service then apply filters in-memory.
    // Transfers volume per venue is low (tens, not thousands) so this is fine.
    const pageNum = Math.max(1, parseInt((page as string) || '1', 10))
    const size = Math.min(200, Math.max(1, parseInt((pageSize as string) || '50', 10)))

    const { transfers, pagination } = await transferMobileService.listTransfers(venueId, 1, 1000)

    let filtered = transfers
    if (status) {
      filtered = filtered.filter(t => t.status === status)
    }
    if (search) {
      const term = (search as string).toLowerCase()
      filtered = filtered.filter(
        t =>
          t.fromLocationName?.toLowerCase().includes(term) ||
          t.toLocationName?.toLowerCase().includes(term) ||
          t.createdByName?.toLowerCase().includes(term),
      )
    }
    if (startDate) {
      const start = new Date(startDate as string)
      filtered = filtered.filter(t => new Date(t.createdAt) >= start)
    }
    if (endDate) {
      const end = new Date(endDate as string)
      end.setHours(23, 59, 59, 999)
      filtered = filtered.filter(t => new Date(t.createdAt) <= end)
    }

    const total = filtered.length
    const start = (pageNum - 1) * size
    const paged = filtered.slice(start, start + size)

    // Add convenience itemCount for list rendering
    const rows = paged.map(t => ({
      ...t,
      itemCount: Array.isArray(t.items) ? t.items.length : 0,
    }))

    res.json({
      success: true,
      data: rows,
      pagination: {
        page: pageNum,
        pageSize: size,
        total,
        totalPages: Math.ceil(total / size),
        // Include source total so consumers know if the raw page was capped
        sourceTotal: pagination.total,
      },
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/inventory/transfers/:transferId
 *
 * Get a single transfer with its full item list.
 */
export async function getTransfer(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, transferId } = req.params

    const transfer = await transferMobileService.getTransfer(transferId, venueId)

    res.json({
      success: true,
      data: transfer,
    })
  } catch (error) {
    next(error)
  }
}
