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
  /** Sólo Excel: formato de número de sus celdas NUMÉRICAS (p. ej. `'$#,##0.00'`). Sin él, la celda queda como siempre. */
  numFmt?: string
  /** Sólo PDF: peso relativo de su ancho (default 1). Si ninguna columna lo trae, columnas iguales, como siempre. */
  pdfAncho?: number
  /**
   * Sólo PDF: el texto que no cabe se parte en varias líneas y la fila crece, en vez de cortarse con «…» (recibo de pago al
   * personal, QA E6a H13). Sin él, una sola línea por celda, como siempre.
   */
  pdfAjustar?: boolean
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
  /** Nombre de la hoja de Excel si no debe ser el título (se limpia igual). */
  sheetName?: string
  /** Sólo PDF: líneas bajo el título, antes de la tabla (p. ej. los totales por tipo del recibo, QA E6a H13). */
  resumen?: string[]
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

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

/** «29 sep 2026» de una fecha 'AAAA-MM-DD' que ya es local (no se convierte de zona). Fijo, sin depender del ICU. */
export function fechaMx(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return `${d} ${MESES[m - 1]} ${y}`
}

/** «3 oct 2026, 20:48» (24 h, hora de CDMX: la ayuda no conoce la zona de cada sede). */
function fechaHoraMx(instante: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Mexico_City',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(instante)
      .map(x => [x.type, x.value]),
  )
  return `${fechaMx(`${p.year}-${p.month}-${p.day}`)}, ${p.hour}:${p.minute}`
}

/**
 * Nombre de hoja válido para Excel: sin `\ / ? * [ ] :`, a lo más 31 caracteres y, si hubo que cortar, en un límite de
 * palabra y sin separador colgando («Recibo de Carlos Rodríguez ·» → «Recibo de Carlos Rodríguez»).
 */
function nombreDeHoja(title: string): string {
  let s = title
    .replace(/[\\/?*[\]:]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (s.length > 31) {
    const corte = s.slice(0, 32).lastIndexOf(' ')
    s = s.slice(0, corte > 0 ? corte : 31)
  }
  return s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N})]+$/gu, '') || 'Export'
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
  columns.forEach((c, colIdx) => {
    if (!c.numFmt) return
    for (let r = 1; r <= dataRows.length; r++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c: colIdx })]
      if (cell?.t === 'n') cell.z = c.numFmt
    }
  })
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
  XLSX.utils.book_append_sheet(wb, sheet, nombreDeHoja(title))
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
  return {
    buffer,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: 'xlsx',
  }
}

async function encodePdf<TRow>(
  columns: ExportColumnDef<TRow>[],
  rows: TRow[],
  title: string,
  resumen: string[] = [],
): Promise<EncodedExport> {
  // PDFKit is stream-based; we collect chunks then resolve.
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 32 })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>(resolve => {
    doc.on('end', () => resolve(Buffer.concat(chunks)))
  })

  doc.fontSize(16).text(title, { align: 'left' })
  doc.moveDown(0.5)
  doc
    .fontSize(8)
    .fillColor('#666')
    .text(`Generado: ${fechaHoraMx(new Date())}`)
  if (resumen.length) {
    doc.moveDown(0.5)
    doc.fontSize(10).fillColor('#000')
    for (const linea of resumen) doc.text(linea)
  }
  doc.moveDown(1)
  doc.fillColor('#000')

  // Tabla de columnas iguales, salvo que traigan `pdfAncho` (peso relativo). Cada fila calcula su `y` UNA vez y todas sus
  // celdas se dibujan en esa `y` fija: `text()` mueve `doc.y`, así que leerlo celda por celda recorría las celdas (QA pago
  // al staff 2026-10-03, defecto 1).
  const left = doc.page.margins.left
  const pageWidth = doc.page.width - left - doc.page.margins.right
  const pesos = columns.map(c => (c.pdfAncho && c.pdfAncho > 0 ? c.pdfAncho : 1))
  const sumaPesos = pesos.reduce((a, p) => a + p, 0)
  const anchos = pesos.map(p => (pageWidth * p) / sumaPesos)
  const xs = anchos.map((_, i) => left + anchos.slice(0, i).reduce((a, w) => a + w, 0))
  const rowHeight = 16
  const fontSize = columns.length > 8 ? 7 : 9
  let y = doc.y

  // El alto de una fila: 16, o lo que pida la celda `pdfAjustar` más alta (sus líneas + el mismo margen de 4 arriba y abajo).
  const altoDe = (cells: string[]) => {
    doc.fontSize(fontSize)
    const altos = cells.map((texto, i) => (columns[i].pdfAjustar ? doc.heightOfString(texto, { width: anchos[i] - 8 }) + 8 : 0))
    return Math.max(rowHeight, Math.ceil(Math.max(...altos)))
  }
  const drawRow = (cells: string[], fondo: string | null, color: string, alto = rowHeight) => {
    if (fondo) doc.rect(left, y, pageWidth, alto).fill(fondo)
    doc.fontSize(fontSize).fillColor(color)
    // `height` + `ellipsis`: una sola línea por celda, cortada con «…» si no cabe; con `height` pdfkit nunca abre página. Una
    // celda `pdfAjustar` se parte en líneas dentro del alto de SU fila (medido con `altoDe`), sin «…».
    cells.forEach((texto, i) =>
      doc.text(
        texto,
        xs[i] + 4,
        y + 4,
        columns[i].pdfAjustar ? { width: anchos[i] - 8, height: alto } : { width: anchos[i] - 8, height: rowHeight, ellipsis: true },
      ),
    )
    y += alto
  }
  const drawHeader = () =>
    drawRow(
      columns.map(c => c.label),
      '#374151',
      '#fff',
    )

  drawHeader()
  rows.forEach((row, idx) => {
    const cells = columns.map(c => {
      const v = c.value(row)
      return v === null || v === undefined ? '' : String(v)
    })
    const alto = altoDe(cells)
    if (y + alto > doc.page.height - doc.page.margins.bottom) {
      doc.addPage({ size: 'A4', layout: 'landscape', margin: 32 })
      y = doc.page.margins.top
      drawHeader()
    }
    drawRow(cells, idx % 2 === 0 ? '#f3f4f6' : null, '#000', alto) // zebra stripes for readability
  })
  doc.fillColor('#000')
  doc.x = left
  doc.y = y

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
  { allColumns, requestedColumnIds, rows, title, sheetName, resumen }: EncodeExportOptions<TRow>,
): Promise<EncodedExport> {
  const columns = pickColumns(allColumns, requestedColumnIds)
  if (columns.length === 0) {
    throw new Error('No valid columns requested for export')
  }
  if (format === 'csv') return encodeCsv(columns, rows)
  if (format === 'xlsx') return encodeXlsx(columns, rows, sheetName ?? title)
  return encodePdf(columns, rows, title, resumen)
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
