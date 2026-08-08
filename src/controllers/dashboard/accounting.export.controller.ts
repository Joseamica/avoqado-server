/**
 * Accounting exports — expenses (Buzón) and the trial balance.
 *
 * Kept apart from the inventory exports on purpose: this namespace carries a different plan
 * lock (`CFDI`, PREMIUM) and, more importantly, a different money convention.
 *
 * These follow the same shape as the three listings that already export (payments, orders,
 * sales summary): reuse the SAME service the screen calls, refuse rather than truncate, then
 * hand columns to `encodeExport`. Reusing the listing service is the load-bearing part — a
 * second query built for the export drifts from the one behind the screen, and then the file
 * quietly disagrees with what the user is looking at.
 *
 * Query params are parsed here rather than through `validateRequest`, matching the export
 * routes that already ship. That is deliberate: `validateRequest` REPLACES `req.query` with
 * the Zod-parsed object, so a schema that does not list `format` and `columns` silently
 * strips them and every export comes out as an unfiltered CSV.
 */
import { NextFunction, Request, Response } from 'express'

import { listExpenses, type ListExpensesFilters } from '../../services/fiscal/expense.service'
import { currentPeriod, getTrialBalance } from '../../services/fiscal/trialBalance.service'
import {
  encodeExport,
  sendExport,
  parseFormatParam,
  parseColumnsParam,
  getRowCapForFormat,
  type ExportColumnDef,
} from '../../services/dashboard/export.helpers'

/**
 * The ledger and the expense records store whole CENTS (`...Cents`). Everything leaving for a
 * human divides by 100. This is the ONE place in the platform where money is not already in
 * pesos 1:1 — do not "unify" the rest to cents, unify the OUTPUT to pesos. A file shipped 100x
 * loads cleanly into an accountant's system and surfaces weeks later, if ever.
 */
const pesosFromCents = (cents: number | null | undefined): number => (cents == null ? 0 : Math.round(cents) / 100)

/**
 * `listExpenses` hard-caps its own `take` at 500 rows and returns no grand total, so at the
 * ceiling we cannot tell "exactly 500" from "the first 500 of many". That ambiguity is why the
 * export refuses there instead of shipping the first 500 — a file with the first N rows reads
 * as complete, which is the failure nobody reports.
 */
const EXPENSE_LISTING_MAX_ROWS = 500

const YES_NO = (v: boolean | null | undefined): string => (v ? 'Sí' : 'No')

/** Payment status in the reader's language — the enum value is our schema leaking into their report. */
const PAYMENT_STATUS_LABEL: Record<string, string> = {
  UNPAID: 'Pendiente',
  PARTIALLY_PAID: 'Parcial',
  PAID: 'Pagado',
}

const EXPENSE_CATEGORY_LABEL: Record<string, string> = {
  COSTO_MERCANCIA: 'Costo de mercancía',
  GASTO_GENERAL: 'Gasto general',
  ARRENDAMIENTO: 'Arrendamiento',
  COMBUSTIBLE: 'Combustible',
  HONORARIOS: 'Honorarios',
  SERVICIOS: 'Servicios',
  OTRO: 'Otro',
}

const DOCUMENT_TYPE_LABEL: Record<string, string> = {
  INGRESO: 'Ingreso',
  EGRESO: 'Egreso',
  NOMINA: 'Nómina',
  PAGO: 'Pago',
  TRASLADO: 'Traslado',
}

const EXPENSE_STATUS_LABEL: Record<string, string> = {
  REGISTERED: 'Registrado',
  CANCELLED: 'Cancelado',
}

const PAYMENT_STATUSES = ['UNPAID', 'PARTIALLY_PAID', 'PAID'] as const

/** Accept only a known payment status; anything else is treated as "no filter" rather than a 500. */
function parsePaymentStatus(raw: string | undefined): ListExpensesFilters['paymentStatus'] {
  return (PAYMENT_STATUSES as readonly string[]).includes(raw ?? '') ? (raw as ListExpensesFilters['paymentStatus']) : undefined
}

/**
 * GET /accounting/expenses/export — supplier CFDIs (Buzón) for the taxpayer.
 * The sheet a deduction review is done on: what came in, from whom, how much VAT, and whether
 * it is deductible.
 */
export async function exportExpenses(
  req: Request<
    { venueId: string },
    {},
    {},
    { format?: string; columns?: string; period?: string; paymentStatus?: string; proveedorRfc?: string; includeCancelled?: string }
  >,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const format = parseFormatParam(req.query.format)
    const requestedColumnIds = parseColumnsParam(req.query.columns)
    const cap = Math.min(getRowCapForFormat(format), EXPENSE_LISTING_MAX_ROWS)

    const filters: ListExpensesFilters = {
      period: req.query.period || undefined,
      paymentStatus: parsePaymentStatus(req.query.paymentStatus),
      proveedorRfc: req.query.proveedorRfc || undefined,
      includeCancelled: req.query.includeCancelled === 'true',
      limit: EXPENSE_LISTING_MAX_ROWS,
    }

    const result = await listExpenses(venueId, filters)

    // An empty file reads as "there were no expenses". The truth here is "this venue has no
    // RFC configured" — a different problem with a different fix, and one the reader cannot
    // infer from a blank sheet.
    if (result.needsFiscalSetup) {
      res.status(400).json({
        success: false,
        message: 'Este local aún no tiene un RFC/emisor fiscal configurado. Configura la facturación (CFDI) antes de exportar.',
      })
      return
    }

    const rows = result.expenses
    if (rows.length >= cap) {
      res.status(413).json({
        success: false,
        message: `Esta exportación alcanzó el máximo de ${cap.toLocaleString()} gastos y quedaría incompleta. Acota por periodo (mes), estado de pago o proveedor.`,
      })
      return
    }

    type Row = (typeof rows)[number]

    // Column registry — order here is the order in the output file.
    const allColumns: ExportColumnDef<Row>[] = [
      { id: 'issueDate', label: 'Fecha de emisión', value: r => r.fechaEmision ?? '' },
      { id: 'paymentDate', label: 'Fecha de pago', value: r => r.fechaPago ?? '' },
      { id: 'uuid', label: 'Folio fiscal', value: r => r.uuid ?? '' },
      { id: 'series', label: 'Serie', value: r => r.serie ?? '' },
      { id: 'folio', label: 'Folio', value: r => r.folio ?? '' },
      { id: 'supplierRfc', label: 'RFC proveedor', value: r => r.proveedorRfc ?? '' },
      { id: 'supplierName', label: 'Proveedor', value: r => r.proveedorNombre ?? '' },
      { id: 'documentType', label: 'Tipo de comprobante', value: r => DOCUMENT_TYPE_LABEL[r.comprobanteTipo] ?? r.comprobanteTipo ?? '' },
      { id: 'category', label: 'Categoría', value: r => EXPENSE_CATEGORY_LABEL[r.categoria] ?? r.categoria ?? '' },
      // PUE/PPD are the SAT's own terms, not our schema — an accountant reads them natively.
      { id: 'paymentMethod', label: 'Método de pago', value: r => r.metodoPago ?? '' },
      { id: 'subtotal', label: 'Subtotal', value: r => pesosFromCents(r.subtotalCents) },
      { id: 'discount', label: 'Descuento', value: r => pesosFromCents(r.descuentoCents) },
      { id: 'vat', label: 'IVA', value: r => pesosFromCents(r.ivaCents) },
      { id: 'excise', label: 'IEPS', value: r => pesosFromCents(r.iepsCents) },
      { id: 'incomeTaxWithheld', label: 'ISR retenido', value: r => pesosFromCents(r.isrRetenidoCents) },
      { id: 'vatWithheld', label: 'IVA retenido', value: r => pesosFromCents(r.ivaRetenidoCents) },
      { id: 'total', label: 'Total', value: r => pesosFromCents(r.totalCents) },
      { id: 'paidAmount', label: 'Pagado', value: r => pesosFromCents(r.paidCents) },
      { id: 'paymentStatus', label: 'Estado de pago', value: r => PAYMENT_STATUS_LABEL[r.paymentStatus] ?? r.paymentStatus ?? '' },
      { id: 'deductible', label: 'Deducible', value: r => YES_NO(r.deducible) },
      { id: 'creditableVat', label: 'IVA acreditable', value: r => YES_NO(r.ivaAcreditable) },
      { id: 'posted', label: 'Contabilizado', value: r => YES_NO(r.posted) },
      { id: 'status', label: 'Estatus', value: r => EXPENSE_STATUS_LABEL[r.status] ?? r.status ?? '' },
    ]

    const encoded = await encodeExport(format, {
      allColumns,
      requestedColumnIds: requestedColumnIds.length > 0 ? requestedColumnIds : allColumns.map(c => c.id),
      rows,
      title: 'Gastos',
    })

    sendExport(res, encoded, filters.period ? `gastos-${filters.period}` : 'gastos')
  } catch (error) {
    next(error)
  }
}

/**
 * GET /accounting/trial-balance/export — the period's trial balance, one row per account.
 * This is the file an external accountant loads, so the debit/credit equality has to survive
 * the conversion to pesos.
 */
export async function exportTrialBalance(
  req: Request<{ venueId: string }, {}, {}, { format?: string; columns?: string; period?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const format = parseFormatParam(req.query.format)
    const requestedColumnIds = parseColumnsParam(req.query.columns)
    const cap = getRowCapForFormat(format)
    const period = req.query.period || currentPeriod()

    const result = await getTrialBalance(venueId, period)

    if (result.needsFiscalSetup) {
      res.status(400).json({
        success: false,
        message: 'Este local aún no tiene un RFC/emisor fiscal configurado. Configura la facturación (CFDI) antes de exportar.',
      })
      return
    }

    const rows = result.rows
    if (rows.length > cap) {
      res.status(413).json({
        success: false,
        message:
          format === 'pdf'
            ? `La balanza tiene ${rows.length.toLocaleString()} cuentas. PDF está limitado a ${cap.toLocaleString()}. Usa CSV o Excel.`
            : `La balanza tiene ${rows.length.toLocaleString()} cuentas. El máximo por exportación es ${cap.toLocaleString()}.`,
      })
      return
    }

    type Row = (typeof rows)[number]

    const allColumns: ExportColumnDef<Row>[] = [
      { id: 'code', label: 'Cuenta', value: r => r.code ?? '' },
      { id: 'name', label: 'Nombre', value: r => r.name ?? '' },
      { id: 'type', label: 'Tipo', value: r => r.type ?? '' },
      { id: 'nature', label: 'Naturaleza', value: r => r.nature ?? '' },
      // Signed net balances (+ = deudor, − = acreedor), matching the service's convention.
      { id: 'openingBalance', label: 'Saldo inicial', value: r => pesosFromCents(r.saldoInicialCents) },
      { id: 'debit', label: 'Cargos', value: r => pesosFromCents(r.debeCents) },
      { id: 'credit', label: 'Abonos', value: r => pesosFromCents(r.haberCents) },
      { id: 'closingBalance', label: 'Saldo final', value: r => pesosFromCents(r.saldoFinalCents) },
    ]

    const encoded = await encodeExport(format, {
      allColumns,
      requestedColumnIds: requestedColumnIds.length > 0 ? requestedColumnIds : allColumns.map(c => c.id),
      rows,
      title: 'Balanza de comprobación',
    })

    sendExport(res, encoded, `balanza-${period}`)
  } catch (error) {
    next(error)
  }
}
