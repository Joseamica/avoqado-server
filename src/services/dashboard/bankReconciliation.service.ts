import { OrderStatus, PaymentMethod, TransactionStatus } from '@prisma/client'
import Papa from 'papaparse'

import prisma from '../../utils/prismaClient'
import { formatInVenueTimezone, venueEndOfDay, venueStartOfDay } from '../../utils/datetime'

/**
 * Bank Reconciliation (Conciliación bancaria con IA) — Slice 1 core.
 *
 * El moat: Avoqado SABE lo que depositó (procesó los pagos), así que conciliar el
 * estado de cuenta del banco contra "lo que Avoqado procesó" es de alta confianza —
 * a diferencia de Alegra, que importa CFDI del SAT y adivina.
 *
 * Fuente de candidatos = **pagos electrónicos netos agrupados por día (zona del venue)**.
 * (Decisión 2026-06-15: los settlements `VenueTransaction` van VACÍOS en la data real
 * — `actualSettlementDate` 0/391 — así que derivamos el depósito esperado del Payment,
 * que sí es rico. La IA (parsear PDFs / fuzzy match) es slice 2; el matcher es el contrato
 * estable, el parseo es intercambiable detrás de él.)
 *
 * `matchLines` es PURO y determinista (testeable sin DB ni LLM).
 */

export type ReconMatchStatus = 'UNMATCHED' | 'MATCHED' | 'DUPLICATE'

export interface ParsedBankLine {
  rowIndex: number
  /** Día calendario de la línea, anclado a mediodía local (estable para comparar días). */
  postedDate: Date
  description: string
  reference: string | null
  /** Centavos con signo; depósitos (CREDIT) > 0. */
  amountCents: number
  direction: 'CREDIT' | 'DEBIT'
}

export interface DepositCandidate {
  /** Clave de agrupación = día venue-local (YYYY-MM-DD). */
  key: string
  /** Día del depósito esperado, anclado a mediodía local. */
  date: Date
  /** Depósito esperado = Σ netAmount de pagos electrónicos COMPLETED de ese día. */
  netCents: number
  paymentCount: number
}

export interface MatchResult {
  rowIndex: number
  matchStatus: ReconMatchStatus
  /** 0..1 — 1.0 exacto, 0.9 dentro de tolerancia. */
  matchScore: number
  /** El día-candidato que concilia esta línea, o null si no cuadró. */
  matchedKey: string | null
}

const toCents = (n: number | { toString(): string } | null | undefined): number => (n == null ? 0 : Math.round(Number(n) * 100))
const daysBetween = (a: Date, b: Date): number => Math.abs(Math.round((a.getTime() - b.getTime()) / 86_400_000))
const localNoon = (ymd: string): Date => new Date(`${ymd}T12:00:00`)

/** "1,234.56" / "$1,234.56" / "(123.45)" / "-123.45" → centavos enteros con signo. */
function parseAmountCents(raw: string | undefined): number {
  if (!raw) return 0
  let s = raw.trim()
  const negative = /^\(.*\)$/.test(s) || s.startsWith('-')
  s = s.replace(/[()$\s]/g, '').replace(/,/g, '').replace(/^-/, '')
  const n = parseFloat(s)
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100) * (negative ? -1 : 1)
}

/** DD/MM/YYYY · DD-MM-YYYY · YYYY-MM-DD → Date anclada a mediodía local (host-tz-safe para comparar días). */
function parseBankDate(raw: string | undefined): Date | null {
  if (!raw) return null
  const s = raw.trim()
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/) // YYYY-MM-DD
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/) // DD/MM/YYYY (convención MX)
  if (m) {
    const year = Number(m[3].length === 2 ? `20${m[3]}` : m[3])
    return new Date(year, Number(m[2]) - 1, Number(m[1]), 12)
  }
  return null
}

const COLS = {
  date: ['fecha', 'date', 'dia'],
  desc: ['descrip', 'concepto', 'detalle', 'description', 'movimiento'],
  ref: ['referencia', 'rastreo', 'folio', 'reference', 'autorizacion'],
  credit: ['abono', 'deposito', 'depósito', 'credito', 'crédito', 'haber'],
  debit: ['cargo', 'retiro', 'debito', 'débito', 'debe'],
  amount: ['monto', 'importe', 'amount', 'valor'],
}
const findCol = (headers: string[], keys: string[]): string | null => headers.find(h => keys.some(k => h.includes(k))) ?? null

/**
 * Parsea un CSV de estado de cuenta a líneas normalizadas. Mapeo de columnas flexible
 * para bancos MX (BBVA/Banorte/Santander/HSBC): soporta columnas separadas cargo/abono
 * o una sola columna monto/importe con signo. (Formatos raros/PDF → IA en slice 2.)
 */
export function parseBankCsv(content: string): ParsedBankLine[] {
  const parsed = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: true,
    transformHeader: h => h.trim().toLowerCase(),
  })
  const rows = parsed.data
  if (rows.length === 0) return []

  const headers = Object.keys(rows[0])
  const cDate = findCol(headers, COLS.date)
  const cDesc = findCol(headers, COLS.desc)
  const cRef = findCol(headers, COLS.ref)
  const cCredit = findCol(headers, COLS.credit)
  const cDebit = findCol(headers, COLS.debit)
  const cAmount = findCol(headers, COLS.amount)

  const lines: ParsedBankLine[] = []
  rows.forEach((row, i) => {
    const postedDate = parseBankDate(cDate ? row[cDate] : undefined)
    if (!postedDate) return // fila sin fecha válida → se ignora (encabezados/saldos)

    let amountCents = 0
    let direction: 'CREDIT' | 'DEBIT' = 'CREDIT'
    if (cCredit || cDebit) {
      const credit = parseAmountCents(cCredit ? row[cCredit] : undefined)
      const debit = parseAmountCents(cDebit ? row[cDebit] : undefined)
      if (credit > 0) {
        amountCents = credit
        direction = 'CREDIT'
      } else if (debit > 0) {
        amountCents = -debit
        direction = 'DEBIT'
      } else {
        return // fila sin monto
      }
    } else if (cAmount) {
      const signed = parseAmountCents(row[cAmount])
      if (signed === 0) return
      amountCents = signed
      direction = signed >= 0 ? 'CREDIT' : 'DEBIT'
    } else {
      return
    }

    lines.push({
      rowIndex: i,
      postedDate,
      description: (cDesc ? row[cDesc] : '')?.trim() || '',
      reference: (cRef ? row[cRef] : '')?.trim() || null,
      amountCents,
      direction,
    })
  })
  return lines
}

/**
 * Depósitos esperados = Σ netAmount de pagos electrónicos (no efectivo) COMPLETED por
 * día venue-local. Host-tz-safe: límites del rango con `fromZonedTime(string)` y la
 * agrupación por día con `formatInVenueTimezone` (nunca deja que el runtime parsee una
 * fecha pelada — ver regla de timezone).
 */
export async function loadDepositCandidates(venueId: string, fromYmd: string, toYmd: string, timezone: string): Promise<DepositCandidate[]> {
  // Noon-anchor pattern (host-tz-safe): the venue-local calendar day survives any host TZ.
  const from = venueStartOfDay(timezone, new Date(`${fromYmd}T12:00:00`))
  const to = venueEndOfDay(timezone, new Date(`${toYmd}T12:00:00`))

  const payments = await prisma.payment.findMany({
    where: {
      venueId,
      status: TransactionStatus.COMPLETED,
      method: { not: PaymentMethod.CASH }, // efectivo no se deposita electrónicamente
      createdAt: { gte: from, lte: to },
      order: { status: { not: OrderStatus.CANCELLED } },
    },
    select: { netAmount: true, createdAt: true },
  })

  const byDay = new Map<string, { cents: number; count: number }>()
  for (const p of payments) {
    const ymd = formatInVenueTimezone(p.createdAt, timezone, 'yyyy-MM-dd')
    const e = byDay.get(ymd) ?? { cents: 0, count: 0 }
    e.cents += toCents(p.netAmount)
    e.count += 1
    byDay.set(ymd, e)
  }

  return [...byDay.entries()].map(([ymd, e]) => ({ key: ymd, date: localNoon(ymd), netCents: e.cents, paymentCount: e.count }))
}

/**
 * EL MOAT — puro, determinista, testeable sin DB ni LLM.
 * Concilia líneas de DEPÓSITO (CREDIT) del banco contra los depósitos esperados.
 * - MATCHED: monto dentro de tolerancia (slice 1 = exacto) Y dentro de ventana de fechas
 *   (el banco postea T+1/T+2). Un candidato se consume una sola vez.
 * - DUPLICATE: misma (monto, día, referencia) aparece dos veces (doble-post o re-subida).
 * - UNMATCHED: depósito sin candidato (efectivo depositado a mano, ingreso externo, o un
 *   depósito que no registramos) → señal real para revisar. Las líneas DEBIT quedan fuera.
 */
export function matchLines(
  lines: ParsedBankLine[],
  candidates: DepositCandidate[],
  opts?: { amountTolCents?: number; dateWindowDays?: number },
): MatchResult[] {
  const amountTol = opts?.amountTolCents ?? 0
  const dateWindow = opts?.dateWindowDays ?? 2
  const used = new Set<string>()
  const seen = new Set<string>()
  const results: MatchResult[] = []

  for (const line of lines) {
    if (line.direction !== 'CREDIT') {
      results.push({ rowIndex: line.rowIndex, matchStatus: 'UNMATCHED', matchScore: 0, matchedKey: null })
      continue
    }
    const dupKey = `${line.amountCents}|${formatDay(line.postedDate)}|${line.reference ?? ''}`
    if (seen.has(dupKey)) {
      results.push({ rowIndex: line.rowIndex, matchStatus: 'DUPLICATE', matchScore: 1, matchedKey: null })
      continue
    }
    seen.add(dupKey)

    const cands = candidates
      .filter(c => !used.has(c.key) && Math.abs(c.netCents - line.amountCents) <= amountTol && daysBetween(c.date, line.postedDate) <= dateWindow)
      .sort(
        (a, b) =>
          Math.abs(a.netCents - line.amountCents) - Math.abs(b.netCents - line.amountCents) ||
          daysBetween(a.date, line.postedDate) - daysBetween(b.date, line.postedDate),
      )

    const best = cands[0]
    if (best) {
      used.add(best.key)
      const score = best.netCents === line.amountCents ? 1 : 0.9
      results.push({ rowIndex: line.rowIndex, matchStatus: 'MATCHED', matchScore: score, matchedKey: best.key })
    } else {
      results.push({ rowIndex: line.rowIndex, matchStatus: 'UNMATCHED', matchScore: 0, matchedKey: null })
    }
  }
  return results
}

const formatDay = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
