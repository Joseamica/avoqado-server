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
  flattenSalesSummaryForExport,
  countSalesSummaryDetailRows,
  fetchSalesSummaryDetailRows,
} from '@/services/dashboard/sales-summary.dashboard.service'
import { encodeExport, sendExport, parseColumnsParam, parseFormatParam, getRowCapForFormat } from '@/services/dashboard/export.helpers'
import AppError, { BadRequestError } from '@/errors/AppError'
import { leerConComparacion, OPCIONES_DE_COMPARAR } from '@/services/dashboard/salesSummaryComparar'
import type { CompararCon } from '@/services/dashboard/sales-summary.dashboard.service'
import { exigirComercioDelNegocio } from '@/services/venuePaymentConfig.service'
import { zonaDelCalculo } from '@/utils/sanitizeTimezone'
import { COLUMNAS_DEL_ARCHIVO, encabezadoDelArchivo, filasDelArchivo } from '@/services/dashboard/salesSummaryExportLabels'
import { decidirCarril, MENSAJE_GET_VIEJO_GRANDE } from '@/services/exports/exportPolicy'
import { MENSAJE_QR_ANTERIOR_SIN_DETALLE, VENTAS_DETALLADAS_COLUMNAS } from '@/services/exports/exportadores/ventasDetalladas.exportador'
import { AVISO_PUENTE_QR_CAIDO, MINDFORM_NEW_VENUE_ID } from '@/services/legacy/qrPayments.legacy.service'
import { resolveRequestVenueId } from '@/middlewares/checkPermission.middleware'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import prisma from '@/utils/prismaClient'
import { esSuperadminDeLaSesion } from '../../services/access/rolVigente'

const esUn400 = (error: unknown) => error instanceof AppError && error.statusCode === 400

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
 * - compareTo: 'previous_period' | 'previous_year' (optional, carril F2) - adds `comparison` (the other period read up to the same
 *   time, its figures and the changes). What prevents comparing goes inside `comparison.status`; the report always comes back.
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
      includeChannelBreakdown,
      includePrepaid,
      compareTo,
    } = req.query

    if (compareTo !== undefined && !OPCIONES_DE_COMPARAR.includes(compareTo as CompararCon)) {
      throw new BadRequestError(`compareTo no válido. Usa: ${OPCIONES_DE_COMPARAR.join(', ')}`)
    }

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
      wantsReconciliation && ((await esSuperadminDeLaSesion(req.authContext)) || (await venueHasFeatureAccess(venueId, 'ADVANCED_REPORTS')))

    const filters: SalesSummaryFilters = {
      startDate,
      endDate,
      groupBy: (groupBy as 'none' | 'paymentMethod') || 'none',
      reportType: (reportType as ReportType) || 'summary',
      // «GMT-6» guardado (altas viejas) no es IANA: «Por días» daba 400 y la proyección 500 (hz:fefa11b6:D15). Como el exporte.
      timezone: zonaDelCalculo(venue?.timezone),
      merchantAccountId: typeof merchantAccountId === 'string' ? merchantAccountId : undefined,
      paymentMethod: typeof paymentMethod === 'string' ? (paymentMethod as PaymentMethodFilter) : undefined,
      cardType: typeof cardType === 'string' ? (cardType as CardTypeFilter) : undefined,
      includeMerchantBreakdown: includeMerchantBreakdown === 'true' && reconciliationAllowed,
      includeSettlementProjection: includeSettlementProjection === 'true' && reconciliationAllowed,
      // Carril G · D4 y D5: «Ventas por canal», «Por tipo de pedido» y los anticipos van en TODOS los planes, sin candado (decisión
      // del founder del 22-nov, como el agrupar por origen o canal de Square y el channel-mix del Inicio).
      includeChannelBreakdown: includeChannelBreakdown === 'true',
      includePrepaid: includePrepaid === 'true',
    }

    await exigirComercioDelNegocio(venueId, merchantAccountId) // el valor crudo: una lista (parámetro repetido) es 400, no «sin filtro»
    const report = compareTo
      ? await leerConComparacion(venueId, filters, compareTo as CompararCon)
      : await getSalesSummary(venueId, filters)

    res.json({
      success: true,
      data: report,
    })
  } catch (error) {
    // Un 400 esperado (el filtro de comercio de otro negocio, dos comercios, un parámetro mal escrito) no es una falla del servidor.
    if (esUn400(error)) logger.warn('Sales summary report rejected:', { message: (error as Error).message })
    else logger.error('Sales summary report error:', error)
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
 * - sections: comma list (summary mode) — totals,paymentMethods,cardTypes,merchantAccounts,byPeriod,statement. Sent but with no
 *   valid section ⇒ 400; absent ⇒ totals,paymentMethods.
 * - reportType (summary mode, with byPeriod): the screen's report type; absent or 'summary' ⇒ 'days'
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
    // Carril F (Codex r13): el filtro de comercio es de este negocio (los dos modos); si no, 400 en español.
    await exigirComercioDelNegocio(venueId, merchantAccountId)

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
      if (paymentMethod === 'QR_LEGACY') throw new BadRequestError(MENSAJE_QR_ANTERIOR_SIN_DETALLE)

      const allowed = (await esSuperadminDeLaSesion(req.authContext)) || (await venueHasFeatureAccess(venueId, 'TRANSACTION_EXPORT'))
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

      const requestedColumnIds = parseColumnsParam(req.query.columns)
      const total = await countSalesSummaryDetailRows(venueId, filters)

      // Codex r1 #1: lo grande ya no se arma en esta petición (bloqueaba el hilo, alertas del 6-oct y 3-nov). El PDF no cambia.
      if (format !== 'pdf') {
        const columnas =
          requestedColumnIds.length > 0
            ? VENTAS_DETALLADAS_COLUMNAS.filter(c => requestedColumnIds.includes(c.id)).length
            : VENTAS_DETALLADAS_COLUMNAS.length
        if (decidirCarril({ filas: total, columnas: Math.max(columnas, 1), formato: format }).carril !== 'directo') {
          res.status(413).json({ success: false, message: MENSAJE_GET_VIEJO_GRANDE })
          return
        }
      }
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

      const allColumns = VENTAS_DETALLADAS_COLUMNAS

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

    const validSections: SalesSummaryExportSection[] = [
      'totals',
      'paymentMethods',
      'cardTypes',
      'merchantAccounts',
      'byPeriod',
      'statement',
    ]
    const requestedSections = parseColumnsParam(req.query.sections).filter(s =>
      validSections.includes(s as SalesSummaryExportSection),
    ) as SalesSummaryExportSection[]
    // D13.5: asked for sections and none is valid (nothing ticked) ⇒ say so; never a file the user did not ask for. Without the
    // param at all, the historical default stays (other callers).
    if (req.query.sections !== undefined && requestedSections.length === 0) {
      throw new BadRequestError('Elige al menos una sección para exportar')
    }
    const sections: SalesSummaryExportSection[] = requestedSections.length > 0 ? requestedSections : ['totals', 'paymentMethods']

    const { reportType } = req.query
    const validReportTypes: ReportType[] = ['summary', 'hours', 'days', 'weeks', 'months', 'hourlySum', 'dailySum']
    if (reportType !== undefined && !validReportTypes.includes(reportType as ReportType)) {
      throw new BadRequestError(`Tipo de informe no válido. Debe ser uno de: ${validReportTypes.join(', ')}`)
    }

    // 🔴 TIER GATE (mirrors salesSummaryReport lines 116-130, decision Jose 2026-06-10):
    // the merchant-reconciliation block (byMerchantAccount) rides ADVANCED_REPORTS (PRO tier).
    // Only request includeMerchantBreakdown when the user actually selected the
    // 'merchantAccounts' section AND the venue is entitled (SUPERADMIN bypass OR
    // ADVANCED_REPORTS). NEVER pass it unconditionally — that leaks PRO-tier per-merchant
    // reconciliation data into non-entitled venues. When dropped, getSalesSummary omits
    // byMerchantAccount, so the flattener silently produces no 'merchantAccounts' rows
    // (mirrors the report's additive "silently drop the flag" behavior — no 403 in summary mode).
    // D13.6: the period statement («Estado del periodo») rides the same flag and the same PRO gate. D13.2 (Codex r1 #3): so do the
    // periods — a Free venue's screen never shows them, so its file does not either.
    const wantsMerchantBreakdown = sections.includes('merchantAccounts') || sections.includes('statement')
    const wantsPeriods = sections.includes('byPeriod')
    const proAllowed =
      (wantsMerchantBreakdown || wantsPeriods) &&
      ((await esSuperadminDeLaSesion(req.authContext)) || (await venueHasFeatureAccess(venueId, 'ADVANCED_REPORTS')))
    const reconciliationAllowed = wantsMerchantBreakdown && proAllowed

    // D13.2: «Por periodo» brings the breakdown of the report type on screen; without one (or with «Resumen») it goes by day, so an
    // old DASHBOARD that never sent it also gets rows. Periods are only computed when the section is asked for.
    const periodo: ReportType =
      wantsPeriods && proAllowed ? (reportType && reportType !== 'summary' ? (reportType as ReportType) : 'days') : 'summary'

    const filters: SalesSummaryFilters = {
      startDate,
      endDate,
      groupBy: 'paymentMethod',
      reportType: periodo,
      timezone: zonaDelCalculo(venue?.timezone), // Codex D13 r3 #1, r4: «GMT-6» o «GMT» guardados no tumban «Por periodo»,
      merchantAccountId: typeof merchantAccountId === 'string' ? merchantAccountId : undefined,
      paymentMethod: typeof paymentMethod === 'string' ? (paymentMethod as PaymentMethodFilter) : undefined,
      cardType: typeof cardType === 'string' ? (cardType as CardTypeFilter) : undefined,
      includeMerchantBreakdown: reconciliationAllowed,
    }
    const report = await getSalesSummary(venueId, filters)

    // D13.2 (Codex r1 #6, r3 #6): «Por horas» over a long range can pass the format's cap; say so before labelling every period or
    // building a huge file here.
    const demasiadas = (filas: number, alMenos = false) =>
      res.status(413).json({
        success: false,
        message: `El archivo tendría ${alMenos ? 'al menos ' : ''}${filas.toLocaleString('es-MX')} filas y el máximo en ${format === 'pdf' ? 'PDF' : 'CSV o Excel'} es ${cap.toLocaleString('es-MX')}. Elige un periodo más corto o un desglose más grande (días, semanas o meses).`,
      })
    if ((report.byPeriod?.length ?? 0) > cap) {
      demasiadas(report.byPeriod!.length, true) // sólo los periodos: con las otras secciones son más
      return
    }
    const { rows } = flattenSalesSummaryForExport(report, sections, filters.timezone)
    if (rows.length > cap) {
      demasiadas(rows.length)
      return
    }
    // Carril F (full-testing W3 y W4): el ARCHIVO dice lo que la pantalla (nombres, orden, «Cobrado» con filtro, sin renglones vacíos) y
    // arriba qué periodo y qué filtros trae. Las filas de `flattenSalesSummaryForExport` (las que lee la MCP) no cambian.
    // El comercio elegido va por su clave, no por su nombre: el nombre pedía un permiso aparte, se podía renombrar o reusar y el PDF no
    // dibuja todas las letras (regla de parada del carril F, Codex r8-r11).
    const encabezado = encabezadoDelArchivo(startDate, endDate, filters)
    const encoded = await encodeExport(format, {
      allColumns: COLUMNAS_DEL_ARCHIVO,
      requestedColumnIds: COLUMNAS_DEL_ARCHIVO.map(c => c.id),
      // En el PDF el periodo y los filtros van bajo el título (no se repiten como filas de la tabla).
      rows: filasDelArchivo(rows, report, format === 'pdf' ? [] : encabezado),
      title: 'Resumen de ventas',
      // D15: CSV y Excel llevan el aviso como primera fila (viene en `rows`); el PDF lo lleva además completo bajo el título, con
      // el periodo y los filtros.
      resumen: [...encabezado, ...(report.legacyUnavailable ? [AVISO_PUENTE_QR_CAIDO] : [])],
    })
    logger.info('[SalesSummary export summary]', { venueId, format, sections })
    sendExport(res, encoded, 'resumen-ventas')
  } catch (error) {
    if (esUn400(error)) logger.warn('Sales summary export rejected:', { message: (error as Error).message })
    else logger.error('Sales summary export error:', error)
    next(error)
  }
}
