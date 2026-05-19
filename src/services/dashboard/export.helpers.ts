// services/dashboard/export.helpers.ts
//
// Generic helpers for the listing-export feature (Payments, Orders, etc.).
// The dashboard sends `format=csv|xlsx|pdf`, a list of selected column ids, and a
// filter set; the listing-specific service builds the rows and calls
// `encodeExport()` to get back a `{ buffer, contentType, extension }` tuple.

import * as XLSX from 'xlsx'
import PDFDocument from 'pdfkit'
import { Response } from 'express'

export const EXPORT_ROW_CAP = 10_000 // sync export limit; async job will replace this when we ship one
export const EXPORT_PDF_ROW_CAP = 1_000 // PDF is the heaviest format; cap it harder

export type ExportFormat = 'csv' | 'xlsx' | 'pdf'

export interface ExportColumnDef<TRow> {
  /** Stable id (matches what the dashboard sends in `?columns=`). */
  id: string
  /** Human-readable header for the first row / sheet header / PDF heading. */
  label: string
  /** Pluck the cell value from a row. Returns string | number | null. */
  value: (row: TRow) => string | number | null | undefined
}

export interface EncodeExportOptions<TRow> {
  /** All available columns the caller supports (defines the order in the output). */
  allColumns: ExportColumnDef<TRow>[]
  /** Subset of column ids the user requested. Order is preserved from `allColumns`. */
  requestedColumnIds: string[]
  /** Rows to write. */
  rows: TRow[]
  /** Title for PDF / sheet name for XLSX. */
  title: string
}

export interface EncodedExport {
  buffer: Buffer
  contentType: string
  extension: 'csv' | 'xlsx' | 'pdf'
}

/**
 * Pick the columns the user asked for, preserving `allColumns` order. Unknown ids are skipped silently.
 */
function pickColumns<TRow>(allColumns: ExportColumnDef<TRow>[], requestedIds: string[]): ExportColumnDef<TRow>[] {
  const wanted = new Set(requestedIds)
  return allColumns.filter(c => wanted.has(c.id))
}

/**
 * Escape a single CSV field per RFC 4180: wrap in quotes if it contains a delimiter,
 * quote, or newline; double any embedded quotes.
 */
function csvField(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  const s = String(raw)
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function encodeCsv<TRow>(columns: ExportColumnDef<TRow>[], rows: TRow[]): EncodedExport {
  const header = columns.map(c => csvField(c.label)).join(',')
  const lines = rows.map(row => columns.map(c => csvField(c.value(row) ?? '')).join(','))
  // Excel detects UTF-8 reliably with a BOM, otherwise it mangles accents in Spanish exports.
  const bom = '﻿'
  const body = bom + [header, ...lines].join('\r\n')
  return {
    buffer: Buffer.from(body, 'utf8'),
    contentType: 'text/csv; charset=utf-8',
    extension: 'csv',
  }
}

function encodeXlsx<TRow>(columns: ExportColumnDef<TRow>[], rows: TRow[], title: string): EncodedExport {
  // Build an array-of-arrays; XLSX figures out cell types per cell.
  const headerRow = columns.map(c => c.label)
  const dataRows = rows.map(row => columns.map(c => c.value(row) ?? ''))
  const aoa = [headerRow, ...dataRows]
  const sheet = XLSX.utils.aoa_to_sheet(aoa)
  // Roughly autofit columns based on header + first 50 row widths.
  const widths = headerRow.map((label, colIdx) => {
    let max = String(label).length
    for (let i = 0; i < Math.min(dataRows.length, 50); i++) {
      const v = dataRows[i][colIdx]
      const len = v === null || v === undefined ? 0 : String(v).length
      if (len > max) max = len
    }
    return { wch: Math.min(Math.max(max + 2, 10), 40) }
  })
  ;(sheet as any)['!cols'] = widths
  const wb = XLSX.utils.book_new()
  // Sheet names: max 31 chars, no special characters in some clients — keep it simple.
  const safeTitle = title.replace(/[\\/?*[\]:]/g, '').slice(0, 28) || 'Export'
  XLSX.utils.book_append_sheet(wb, sheet, safeTitle)
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
  return {
    buffer,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: 'xlsx',
  }
}

async function encodePdf<TRow>(columns: ExportColumnDef<TRow>[], rows: TRow[], title: string): Promise<EncodedExport> {
  // PDFKit is stream-based; we collect chunks then resolve.
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 32 })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>(resolve => {
    doc.on('end', () => resolve(Buffer.concat(chunks)))
  })

  doc.fontSize(16).text(title, { align: 'left' })
  doc.moveDown(0.5)
  doc.fontSize(8).fillColor('#666').text(`Generado: ${new Date().toLocaleString()}`)
  doc.moveDown(1)
  doc.fillColor('#000')

  // Naive table: equal-width columns. For wide column counts, font shrinks.
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right
  const colWidth = pageWidth / columns.length
  const rowHeight = 16
  const fontSize = columns.length > 8 ? 7 : 9

  const drawHeader = () => {
    doc.fontSize(fontSize).fillColor('#fff')
    doc.rect(doc.page.margins.left, doc.y, pageWidth, rowHeight).fill('#374151')
    let x = doc.page.margins.left
    columns.forEach(c => {
      doc.fillColor('#fff').text(c.label, x + 4, doc.y - rowHeight + 4, { width: colWidth - 8, ellipsis: true })
      x += colWidth
    })
    doc.fillColor('#000')
    doc.moveDown(0.2)
  }

  drawHeader()

  rows.forEach((row, idx) => {
    if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage({ size: 'A4', layout: 'landscape', margin: 32 })
      drawHeader()
    }
    // zebra stripes for readability
    if (idx % 2 === 0) {
      doc.rect(doc.page.margins.left, doc.y, pageWidth, rowHeight).fill('#f3f4f6')
      doc.fillColor('#000')
    }
    let x = doc.page.margins.left
    columns.forEach(c => {
      const v = c.value(row)
      doc.fontSize(fontSize).text(v === null || v === undefined ? '' : String(v), x + 4, doc.y - rowHeight + 4, {
        width: colWidth - 8,
        ellipsis: true,
      })
      x += colWidth
    })
    doc.moveDown(0.2)
  })

  doc.end()
  const buffer = await done

  return {
    buffer,
    contentType: 'application/pdf',
    extension: 'pdf',
  }
}

/**
 * Build the export file for the requested format + columns.
 * Caller is responsible for caps + the actual DB query — this just encodes.
 */
export async function encodeExport<TRow>(
  format: ExportFormat,
  { allColumns, requestedColumnIds, rows, title }: EncodeExportOptions<TRow>,
): Promise<EncodedExport> {
  const columns = pickColumns(allColumns, requestedColumnIds)
  if (columns.length === 0) {
    throw new Error('No valid columns requested for export')
  }
  if (format === 'csv') return encodeCsv(columns, rows)
  if (format === 'xlsx') return encodeXlsx(columns, rows, title)
  return encodePdf(columns, rows, title)
}

/**
 * Write an EncodedExport to the response with the right headers + filename.
 */
export function sendExport(res: Response, encoded: EncodedExport, filenameStem: string): void {
  const stamp = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const filename = `${filenameStem}-${stamp}.${encoded.extension}`
  res.setHeader('Content-Type', encoded.contentType)
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.setHeader('Content-Length', encoded.buffer.length.toString())
  res.status(200).send(encoded.buffer)
}

/**
 * Validate the requested format + return the cap that applies.
 */
export function getRowCapForFormat(format: ExportFormat): number {
  return format === 'pdf' ? EXPORT_PDF_ROW_CAP : EXPORT_ROW_CAP
}

/**
 * Parse a CSV-style query param (`columns=a,b,c`) into a deduped string array.
 */
export function parseColumnsParam(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  const seen = new Set<string>()
  raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .forEach(s => seen.add(s))
  return Array.from(seen)
}

/**
 * Parse + validate the `format` query param.
 */
export function parseFormatParam(raw: unknown): ExportFormat {
  if (raw === 'xlsx' || raw === 'pdf' || raw === 'csv') return raw
  return 'csv'
}
