/**
 * Modifier Inventory Analytics Controller
 *
 * Handles API endpoints for modifier inventory analytics:
 * - Usage statistics
 * - Low stock alerts
 * - Cost impact analysis
 */

import { Request, Response, NextFunction } from 'express'
import * as modifierAnalyticsService from '../../services/dashboard/modifierInventoryAnalytics.service'
import logger from '../../config/logger'
import { ForbiddenError } from '../../errors/AppError'

// Helper to validate tenant isolation
function validateVenueAccess(req: Request, venueId: string): void {
  const authContext = (req as any).authContext
  // OWNER and SUPERADMIN can access any venue in their org
  if (authContext.role === 'OWNER' || authContext.role === 'SUPERADMIN') {
    return
  }
  // Other roles must match the venue they're assigned to
  if (authContext.venueId !== venueId) {
    throw new ForbiddenError('Access denied to this venue')
  }
}

/**
 * GET /dashboard/venues/:venueId/modifiers/inventory/usage
 * Get modifier usage statistics
 */
export async function getModifierUsageStatsHandler(
  req: Request<{ venueId: string }, {}, {}, { startDate?: string; endDate?: string; modifierGroupId?: string; limit?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    validateVenueAccess(req, venueId)

    const { startDate, endDate, modifierGroupId, limit } = req.query

    const stats = await modifierAnalyticsService.getModifierUsageStats(venueId, {
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      modifierGroupId,
      limit: limit ? parseInt(limit, 10) : undefined,
    })

    res.status(200).json({
      success: true,
      data: stats,
    })
  } catch (error) {
    logger.error('Error getting modifier usage stats', { error })
    next(error)
  }
}

/**
 * GET /dashboard/venues/:venueId/modifiers/inventory/low-stock
 * Get modifiers with low stock raw materials
 */
export async function getModifiersLowStockHandler(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    validateVenueAccess(req, venueId)

    const lowStock = await modifierAnalyticsService.getModifiersLowStock(venueId)

    res.status(200).json({
      success: true,
      data: lowStock,
      count: lowStock.length,
    })
  } catch (error) {
    logger.error('Error getting modifiers low stock', { error })
    next(error)
  }
}

/**
 * GET /dashboard/venues/:venueId/modifiers/inventory/summary
 * Get comprehensive modifier inventory summary
 */
export async function getModifierInventorySummaryHandler(
  req: Request<{ venueId: string }, {}, {}, { startDate?: string; endDate?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    validateVenueAccess(req, venueId)

    const { startDate, endDate } = req.query

    const summary = await modifierAnalyticsService.getModifierInventorySummary(venueId, {
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
    })

    res.status(200).json({
      success: true,
      data: summary,
    })
  } catch (error) {
    logger.error('Error getting modifier inventory summary', { error })
    next(error)
  }
}

/**
 * GET /dashboard/venues/:venueId/modifiers/inventory/list
 * Get all modifiers with their inventory configuration
 */
export async function getModifiersWithInventoryHandler(
  req: Request<{ venueId: string }, {}, {}, { includeInactive?: string; groupId?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    validateVenueAccess(req, venueId)

    const { includeInactive, groupId } = req.query

    const modifiers = await modifierAnalyticsService.getModifiersWithInventory(venueId, {
      includeInactive: includeInactive === 'true',
      groupId,
    })

    res.status(200).json({
      success: true,
      data: modifiers,
      count: modifiers.length,
    })
  } catch (error) {
    logger.error('Error getting modifiers with inventory', { error })
    next(error)
  }
}
