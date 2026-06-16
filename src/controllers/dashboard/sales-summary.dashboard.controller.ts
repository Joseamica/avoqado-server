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
  SalesSummaryExportFilters,
  SalesSummaryExportSection,
  SalesSummaryExportRow,
  flattenSalesSummaryForExport,
  countSalesSummaryDetailRows,
  fetchSalesSummaryDetailRows,
} from '@/services/dashboard/sales-summary.dashboard.service'
import {
  encodeExport,
  sendExport,
  parseColumnsParam,
  parseFormatParam,
  getRowCapForFormat,
  type ExportColumnDef,
} from '@/services/dashboard/export.helpers'
import { BadRequestError } from '@/errors/AppError'
import { MINDFORM_NEW_VENUE_ID } from '@/services/legacy/qrPayments.legacy.service'
import { resolveRequestVenueId } from '@/middlewares/checkPermission.middleware'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
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
    const {
      startDate,
      endDate,
      groupBy,
      reportType,
      merchantAccountId,
      paymentMethod,
      cardType,
      includeMerchantBreakdown,
      includeSettlementProjection,
    } = req.query

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

    // PRO gate (decision: Jose 2026-06-10) — the merchant reconciliation block
    // (per-merchant breakdown + settlement projection) rides the ADVANCED_REPORTS
    // feature code (PRO tier in plan-catalog). The flags are silently dropped for
    // non-entitled venues (additive endpoint — no 403; the UI shows the upsell).
    // SUPERADMIN bypasses, mirroring the platform-wide guard rule.
    const wantsReconciliation = includeMerchantBreakdown === 'true' || includeSettlementProjection === 'true'
    const reconciliationAllowed =
      wantsReconciliation && (req.authContext?.role === 'SUPERADMIN' || (await venueHasFeatureAccess(venueId, 'ADVANCED_REPORTS')))

    const filters: SalesSummaryFilters = {
      startDate,
      endDate,
      groupBy: (groupBy as 'none' | 'paymentMethod') || 'none',
      reportType: (reportType as ReportType) || 'summary',
      timezone: venue?.timezone || 'America/Mexico_City',
      merchantAccountId: typeof merchantAccountId === 'string' ? merchantAccountId : undefined,
      paymentMethod: typeof paymentMethod === 'string' ? (paymentMethod as PaymentMethodFilter) : undefined,
      cardType: typeof cardType === 'string' ? (cardType as CardTypeFilter) : undefined,
      includeMerchantBreakdown: includeMerchantBreakdown === 'true' && reconciliationAllowed,
      includeSettlementProjection: includeSettlementProjection === 'true' && reconciliationAllowed,
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

/**
 * GET /api/v1/dashboard/reports/sales-summary/export
 *
 * Streams a CSV/XLSX/PDF of the sales summary. mode=summary flattens getSalesSummary();
 * mode=detailed (PREMIUM, TRANSACTION_EXPORT) emits per-payment rows. Free-tier range clamp
 * is enforced by clampSalesSummaryRangeToToday in the route chain.
 *
 * Query params (all optional unless noted):
 * - mode: 'summary' (default) | 'detailed'
 * - format: 'csv' (default) | 'xlsx' | 'pdf'
 * - startDate / endDate: ISO date strings (required)
 * - sections: comma list (summary mode) — totals,paymentMethods,cardTypes,merchantAccounts,byPeriod
 * - columns: comma list (detailed mode) — column ids from the registry below
 * - paymentMethod / cardType / merchantAccountId: filter passthrough (both modes)
 * - staffId (single) | staffIds (comma list) / shiftId: DETAILED MODE ONLY
 *
 * @permission reports:read
 */
export async function salesSummaryExport(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const venueId = resolveRequestVenueId(req, req.authContext!)
    if (!venueId) throw new BadRequestError('No venue context for the request')

    const { startDate, endDate, merchantAccountId, paymentMethod, cardType, staffIds, shiftId } = req.query
    const mode = req.query.mode === 'detailed' ? 'detailed' : 'summary'
    const format = parseFormatParam(req.query.format) // 'csv' | 'xlsx' | 'pdf'

    if (!startDate || typeof startDate !== 'string') throw new BadRequestError('startDate is required (ISO date string)')
    if (!endDate || typeof endDate !== 'string') throw new BadRequestError('endDate is required (ISO date string)')

    const validPaymentMethods: PaymentMethodFilter[] = ['CASH', 'CARD', 'QR_LEGACY', 'OTHER']
    if (paymentMethod && !validPaymentMethods.includes(paymentMethod as PaymentMethodFilter)) {
      throw new BadRequestError(`Invalid paymentMethod. Must be one of: ${validPaymentMethods.join(', ')}`)
    }
    const validCardTypes: CardTypeFilter[] = ['CREDIT', 'DEBIT', 'AMEX', 'INTERNATIONAL']
    if (cardType && !validCardTypes.includes(cardType as CardTypeFilter)) {
      throw new BadRequestError(`Invalid cardType. Must be one of: ${validCardTypes.join(', ')}`)
    }
    if (paymentMethod === 'QR_LEGACY' && venueId !== MINDFORM_NEW_VENUE_ID) {
      throw new BadRequestError('QR_LEGACY filter is only available for the MindForm venue')
    }

    const cap = getRowCapForFormat(format)
    const parseList = (raw: unknown): string[] | undefined => {
      if (typeof raw !== 'string') return undefined
      const list = raw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
      return list.length > 0 ? list : undefined
    }
    // `staffId` (single) is accepted as an alias for `staffIds` (comma list) — the dialog can send either.
    const staffIdList = parseList(staffIds) ?? (typeof req.query.staffId === 'string' ? [req.query.staffId] : undefined)

    // ── DETAILED MODE — PREMIUM gate + per-payment rows ───────────────────────
    if (mode === 'detailed') {
      // QR_LEGACY has no per-payment representation: legacy QR transactions live in
      // the legacy avo-pwa store, not the native `Payment` table that the detailed
      // export reads via `payment.findMany`. Letting it through would reach
      // buildPaymentWhereFilter('QR_LEGACY'), which THROWS → unhandled 500. Reject it
      // here (before building filters) so the caller gets a clear 400 instead. Summary
      // mode is unaffected: getSalesSummary short-circuits QR_LEGACY against the legacy DB.
      if (paymentMethod === 'QR_LEGACY') {
        throw new BadRequestError(
          'QR_LEGACY detailed export is not available; legacy QR transactions are not stored per-payment. Use mode=summary.',
        )
      }

      const allowed = req.authContext?.role === 'SUPERADMIN' || (await venueHasFeatureAccess(venueId, 'TRANSACTION_EXPORT'))
      if (!allowed) {
        // REUSE the platform-wide feature-gate 403 contract (verbatim shape from
        // checkFeatureAccess.middleware.ts:113-118) — NOT an invented `code`. The dashboard's
        // FeatureGate/upsell + this dialog's catch read `featureCode` + `subscriptionRequired`.
        res.status(403).json({
          error: 'Feature not available',
          message: `This venue does not have access to the TRANSACTION_EXPORT feature. Please subscribe to enable this feature.`,
          featureCode: 'TRANSACTION_EXPORT',
          subscriptionRequired: true,
        })
        return
      }

      const filters: SalesSummaryExportFilters = {
        startDate,
        endDate,
        paymentMethod: typeof paymentMethod === 'string' ? (paymentMethod as PaymentMethodFilter) : undefined,
        cardType: typeof cardType === 'string' ? (cardType as CardTypeFilter) : undefined,
        merchantAccountId: typeof merchantAccountId === 'string' ? merchantAccountId : undefined,
        staffIds: staffIdList,
        shiftId: typeof shiftId === 'string' ? shiftId : undefined,
      }

      const total = await countSalesSummaryDetailRows(venueId, filters)
      if (total > cap) {
        res.status(413).json({
          success: false,
          message:
            format === 'pdf'
              ? `El rango contiene ${total.toLocaleString()} transacciones. PDF está limitado a ${cap.toLocaleString()}. Usa CSV o Excel, o reduce el rango con filtros.`
              : `El rango contiene ${total.toLocaleString()} transacciones. El máximo por export es ${cap.toLocaleString()}. Reduce el rango con filtros.`,
        })
        return
      }

      const rows = await fetchSalesSummaryDetailRows(venueId, filters, cap)
      type Row = (typeof rows)[number]

      // Column registry — order here is the order in the output file.
      const allColumns: ExportColumnDef<Row>[] = [
        { id: 'createdAt', label: 'Fecha', value: r => r.createdAt?.toISOString() ?? '' },
        { id: 'paymentId', label: 'ID', value: r => r.id },
        {
          id: 'waiterName',
          label: 'Mesero',
          value: r => (r.processedBy ? `${r.processedBy.firstName ?? ''} ${r.processedBy.lastName ?? ''}`.trim() : ''),
        },
        {
          id: 'merchantAccount',
          label: 'Cuenta Comercial',
          value: r => r.merchantAccount?.displayName || r.merchantAccount?.externalMerchantId || '',
        },
        { id: 'method', label: 'Método', value: r => r.method ?? '' },
        { id: 'cardBrand', label: 'Marca', value: r => r.cardBrand ?? '' },
        { id: 'last4', label: 'Últimos 4', value: r => (r.maskedPan ? r.maskedPan.slice(-4) : '') },
        {
          id: 'international',
          label: 'Internacional',
          value: r => ((r.processorData as { isInternational?: boolean } | null)?.isInternational ? 'Sí' : 'No'),
        },
        { id: 'amount', label: 'Subtotal', value: r => Number(r.amount) || 0 },
        { id: 'tipAmount', label: 'Propina', value: r => Number(r.tipAmount) || 0 },
        { id: 'totalAmount', label: 'Total', value: r => (Number(r.amount) || 0) + (Number(r.tipAmount) || 0) },
        { id: 'status', label: 'Estatus', value: r => r.status ?? '' },
        { id: 'source', label: 'Origen', value: r => r.source ?? '' },
      ]

      const requestedColumnIds = parseColumnsParam(req.query.columns)
      const encoded = await encodeExport(format, {
        allColumns,
        requestedColumnIds: requestedColumnIds.length > 0 ? requestedColumnIds : allColumns.map(c => c.id),
        rows,
        title: 'Ventas detalladas',
      })
      logger.info('[SalesSummary export detailed]', { venueId, total, format, columns: requestedColumnIds.length })
      sendExport(res, encoded, 'ventas-detalladas')
      return
    }

    // ── SUMMARY MODE — flatten getSalesSummary numbers ────────────────────────
    // Fetch the venue timezone here (summary mode is the only branch that needs it —
    // for period labels + the getSalesSummary tz arg). Detailed mode does not use it.
    const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })

    const validSections: SalesSummaryExportSection[] = ['totals', 'paymentMethods', 'cardTypes', 'merchantAccounts', 'byPeriod']
    const requestedSections = parseColumnsParam(req.query.sections).filter(s =>
      validSections.includes(s as SalesSummaryExportSection),
    ) as SalesSummaryExportSection[]
    const sections: SalesSummaryExportSection[] = requestedSections.length > 0 ? requestedSections : ['totals', 'paymentMethods']

    // 🔴 TIER GATE (mirrors salesSummaryReport lines 116-130, decision Jose 2026-06-10):
    // the merchant-reconciliation block (byMerchantAccount) rides ADVANCED_REPORTS (PRO tier).
    // Only request includeMerchantBreakdown when the user actually selected the
    // 'merchantAccounts' section AND the venue is entitled (SUPERADMIN bypass OR
    // ADVANCED_REPORTS). NEVER pass it unconditionally — that leaks PRO-tier per-merchant
    // reconciliation data into non-entitled venues. When dropped, getSalesSummary omits
    // byMerchantAccount, so the flattener silently produces no 'merchantAccounts' rows
    // (mirrors the report's additive "silently drop the flag" behavior — no 403 in summary mode).
    const wantsMerchantBreakdown = sections.includes('merchantAccounts')
    const reconciliationAllowed =
      wantsMerchantBreakdown && (req.authContext?.role === 'SUPERADMIN' || (await venueHasFeatureAccess(venueId, 'ADVANCED_REPORTS')))

    const filters: SalesSummaryFilters = {
      startDate,
      endDate,
      groupBy: 'paymentMethod',
      reportType: 'summary',
      timezone: venue?.timezone || 'America/Mexico_City',
      merchantAccountId: typeof merchantAccountId === 'string' ? merchantAccountId : undefined,
      paymentMethod: typeof paymentMethod === 'string' ? (paymentMethod as PaymentMethodFilter) : undefined,
      cardType: typeof cardType === 'string' ? (cardType as CardTypeFilter) : undefined,
      includeMerchantBreakdown: reconciliationAllowed,
    }
    const report = await getSalesSummary(venueId, filters)

    const { rows } = flattenSalesSummaryForExport(report, sections)
    type Row = SalesSummaryExportRow

    const allColumns: ExportColumnDef<Row>[] = [
      { id: 'section', label: 'Sección', value: r => r.section },
      { id: 'label', label: 'Concepto', value: r => r.label },
      { id: 'count', label: 'Cantidad', value: r => r.count },
      { id: 'amount', label: 'Monto', value: r => r.amount },
      { id: 'percentage', label: 'Porcentaje', value: r => r.percentage },
    ]

    const encoded = await encodeExport(format, {
      allColumns,
      requestedColumnIds: allColumns.map(c => c.id),
      rows,
      title: 'Resumen de ventas',
    })
    logger.info('[SalesSummary export summary]', { venueId, format, sections })
    sendExport(res, encoded, 'resumen-ventas')
  } catch (error) {
    logger.error('Sales summary export error:', error)
    next(error)
  }
}
