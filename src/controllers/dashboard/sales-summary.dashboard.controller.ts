/**
 * Sales Summary Dashboard Controller
 *
 * Thin controller layer for sales summary reports.
 * Business logic lives in sales-summary.dashboard.service.ts
 */

import type { Request, Response, NextFunction } from 'express'

import logger from '@/config/logger'
import {
  getSalesSummary,
  SalesSummaryFilters,
  ReportType,
  PaymentMethodFilter,
  CardTypeFilter,
} from '@/services/dashboard/sales-summary.dashboard.service'
import { BadRequestError } from '@/errors/AppError'
import { MINDFORM_NEW_VENUE_ID } from '@/services/legacy/qrPayments.legacy.service'
import { resolveRequestVenueId } from '@/middlewares/checkPermission.middleware'
import prisma from '@/utils/prismaClient'

/**
 * GET /api/v1/dashboard/reports/sales-summary
 *
 * Sales Summary Report - comprehensive sales metrics for a venue
 *
 * Query params:
 * - startDate: ISO date string (required)
 * - endDate: ISO date string (required)
 * - groupBy: 'none' | 'paymentMethod' (optional, default: 'none')
 * - reportType: 'summary' | 'hours' | 'days' | 'weeks' | 'months' | 'hourlySum' | 'dailySum' (optional, default: 'summary')
 * - merchantAccountId: CUID string (optional) - filter by specific merchant account
 * - paymentMethod: 'CASH' | 'CARD' | 'QR_LEGACY' | 'OTHER' (optional) - narrow to a single payment bucket.
 *   When set, order-derived metrics (grossSales/items/discounts/taxes/deferredSales) return null
 *   and only payment-derived metrics (tips/refunds/txCount/platformFees/totalCollected/netProfit)
 *   are computed. QR_LEGACY is only valid for the MindForm venue.
 * - cardType: 'CREDIT' | 'DEBIT' | 'AMEX' | 'INTERNATIONAL' (optional) - sub-filter when paymentMethod=CARD.
 *   Ignored (with a warning) for any other paymentMethod.
 *
 * @permission reports:read
 */
export async function salesSummaryReport(req: Request, res: Response, next: NextFunction) {
  try {
    // Resolve the DATA venue the same way checkPermission('reports:read') did
    // (`:venueId` param -> `x-venue-id` header -> JWT venue), so the report follows
    // the user's active/URL venue instead of the stale JWT venue from login.
    // checkPermission already validated reports:read against this same venue.
    const venueId = resolveRequestVenueId(req, req.authContext!)
    if (!venueId) {
      throw new BadRequestError('No venue context for the request')
    }
    const { startDate, endDate, groupBy, reportType, merchantAccountId, paymentMethod, cardType, includeMerchantBreakdown } = req.query

    // Validate required params
    if (!startDate || typeof startDate !== 'string') {
      throw new BadRequestError('startDate is required (ISO date string)')
    }
    if (!endDate || typeof endDate !== 'string') {
      throw new BadRequestError('endDate is required (ISO date string)')
    }

    // Validate groupBy param
    const validGroupBy = ['none', 'paymentMethod']
    if (groupBy && !validGroupBy.includes(groupBy as string)) {
      throw new BadRequestError(`Invalid groupBy value. Must be one of: ${validGroupBy.join(', ')}`)
    }

    // Validate reportType param
    const validReportTypes: ReportType[] = ['summary', 'hours', 'days', 'weeks', 'months', 'hourlySum', 'dailySum']
    if (reportType && !validReportTypes.includes(reportType as ReportType)) {
      throw new BadRequestError(`Invalid reportType value. Must be one of: ${validReportTypes.join(', ')}`)
    }

    // Validate paymentMethod / cardType filter combination
    const validPaymentMethods: PaymentMethodFilter[] = ['CASH', 'CARD', 'QR_LEGACY', 'OTHER']
    if (paymentMethod && !validPaymentMethods.includes(paymentMethod as PaymentMethodFilter)) {
      throw new BadRequestError(`Invalid paymentMethod. Must be one of: ${validPaymentMethods.join(', ')}`)
    }

    const validCardTypes: CardTypeFilter[] = ['CREDIT', 'DEBIT', 'AMEX', 'INTERNATIONAL']
    if (cardType && !validCardTypes.includes(cardType as CardTypeFilter)) {
      throw new BadRequestError(`Invalid cardType. Must be one of: ${validCardTypes.join(', ')}`)
    }

    if (cardType && paymentMethod !== 'CARD') {
      logger.warn('cardType ignored because paymentMethod is not CARD', { paymentMethod, cardType })
    }

    if (paymentMethod === 'QR_LEGACY' && venueId !== MINDFORM_NEW_VENUE_ID) {
      throw new BadRequestError('QR_LEGACY filter is only available for the MindForm venue')
    }

    // Fetch venue timezone
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { timezone: true },
    })

    const filters: SalesSummaryFilters = {
      startDate,
      endDate,
      groupBy: (groupBy as 'none' | 'paymentMethod') || 'none',
      reportType: (reportType as ReportType) || 'summary',
      timezone: venue?.timezone || 'America/Mexico_City',
      merchantAccountId: typeof merchantAccountId === 'string' ? merchantAccountId : undefined,
      paymentMethod: typeof paymentMethod === 'string' ? (paymentMethod as PaymentMethodFilter) : undefined,
      cardType: typeof cardType === 'string' ? (cardType as CardTypeFilter) : undefined,
      includeMerchantBreakdown: includeMerchantBreakdown === 'true',
    }

    const report = await getSalesSummary(venueId, filters)

    res.json({
      success: true,
      data: report,
    })
  } catch (error) {
    logger.error('Sales summary report error:', error)
    next(error)
  }
}
