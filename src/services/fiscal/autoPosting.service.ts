import { JournalEntrySource, JournalEntryType, OrderStatus, PaymentMethod, PaymentType, Prisma, TransactionStatus } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'

import prisma from '../../utils/prismaClient'
import { parseDbDateRange } from '../../utils/datetime'
import { getMappings } from './accountMapping.service'
import { resolveScopeOrNull } from './chartOfAccounts.service'
import { postJournalEntry } from './journalEntry.service'
import { splitIvaIncluded } from './ivaMath'

/**
 * Motor de POSTEO AUTOMÁTICO de pólizas (Capa B, slice 2). Genera asientos de doble partida
 * BALANCEADOS automáticamente desde los Payment COMPLETED, usando la AccountMapping del
 * contribuyente — para que el libro diario / balanza / reportes se llenen solos (sin captura manual).
 *
 * Modelo verificado por workflow adversario (2026-06-17, ver memoria `auto-posting-engine-spec`):
 *  - VENTA (tarjeta): DEBE banco (G+T−F) · DEBE comisión (F) · HABER ventas (base) · HABER IVA (208.01)
 *    · HABER propinas (T). Efectivo → DEBE caja (G+T), sin comisión. Σdebe == Σhaber al centavo (la
 *    comisión se cancela; el banco es el "plug"). `splitIvaIncluded` es identidad: net+tax==G exacto.
 *  - DEVOLUCIÓN (type=REFUND, montos negativos): espejo con lados invertidos, usa SALES_RETURN (402.01).
 *    Usa los montos de la PROPIA fila de refund (NO la venta original) → soporta devolución PARCIAL.
 *  - IVA cash-basis (LIVA 1-B): el IVA se causa al COBRAR → todo va a 208.01 (IVA trasladado cobrado).
 *  - Idempotente por `pay:${id}:v1` / `refund:${id}:v1` → re-correr el backfill NUNCA duplica.
 *  - Fecha de la póliza = día calendario del LOCAL (formatInTimeZone, tz-safe — evita la trampa bare-date).
 *  - DIFERIDO (otros slices): COGS (de inventario FIFO), IVA de comisión (necesita CFDI del procesador),
 *    tasas mixtas 0%/8%/exento (single 0.16 + flag), ADJUSTMENT (a revisión manual), cripto/no-MXN.
 *
 * Gated PREMIUM (CFDI) en la ruta/MCP. NO bloqueante: corre fuera del path del pago.
 */

const IVA_RATE = 0.16
const DEFAULT_TZ = 'America/Mexico_City'
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/

/** Decimal/number de pesos → centavos enteros (magnitud con signo de origen). */
const toCents = (d: Prisma.Decimal | number | null): number => (d == null ? 0 : Math.round(Number(d) * 100))

/** Movimientos que el motor necesita mapeados para poder postear. */
const REQUIRED_MOVEMENTS = [
  'SALES_REVENUE',
  'SALES_RETURN',
  'IVA_OUTPUT',
  'CASH_RECEIPT',
  'BANK_RECEIPT',
  'TIPS_PAYABLE',
  'PROCESSOR_FEE',
] as const

export interface GenerateResult {
  needsFiscalSetup: boolean
  /** Movimientos sin cuenta asignada — el motor no postea hasta que se mapeen (Configuración contable). */
  missingMappings: string[]
  period: string | null
  /** Pagos elegibles encontrados. */
  candidates: number
  /** Pólizas nuevas generadas en esta corrida. */
  posted: number
  /** Ya estaban posteadas (idempotencia) — se omitieron. */
  alreadyPosted: number
  /** Pagos omitidos por reglas (cancelados/cero/cripto/ajuste). */
  skipped: number
}

interface PaymentRow {
  id: string
  amount: Prisma.Decimal
  tipAmount: Prisma.Decimal
  feeAmount: Prisma.Decimal
  method: PaymentMethod
  type: PaymentType | null
  createdAt: Date
  order: { status: OrderStatus; orderNumber: string | null } | null
}

/** Construye las líneas BALANCEADAS de una póliza de VENTA. null si es una anomalía no posteable. */
function buildSaleLines(
  p: PaymentRow,
  acct: (m: string) => string,
): { lines: { ledgerAccountId: string; debitCents: number; creditCents: number }[] } | null {
  const G = Math.abs(toCents(p.amount))
  const T = Math.abs(toCents(p.tipAmount))
  const F = Math.abs(toCents(p.feeAmount))
  const { netCents, taxCents } = splitIvaIncluded(G, IVA_RATE)
  const isCash = p.method === PaymentMethod.CASH
  // Efectivo ignora comisión; tarjeta neta la comisión del depósito.
  const depositCents = isCash ? G + T : G + T - F
  if (depositCents < 0) return null // comisión > cobro: anomalía, no postear

  const lines: { ledgerAccountId: string; debitCents: number; creditCents: number }[] = []
  if (depositCents > 0)
    lines.push({ ledgerAccountId: acct(isCash ? 'CASH_RECEIPT' : 'BANK_RECEIPT'), debitCents: depositCents, creditCents: 0 })
  if (!isCash && F > 0) lines.push({ ledgerAccountId: acct('PROCESSOR_FEE'), debitCents: F, creditCents: 0 })
  if (netCents > 0) lines.push({ ledgerAccountId: acct('SALES_REVENUE'), debitCents: 0, creditCents: netCents })
  if (taxCents > 0) lines.push({ ledgerAccountId: acct('IVA_OUTPUT'), debitCents: 0, creditCents: taxCents })
  if (T > 0) lines.push({ ledgerAccountId: acct('TIPS_PAYABLE'), debitCents: 0, creditCents: T })
  return lines.length >= 2 ? { lines } : null
}

/** Líneas de una DEVOLUCIÓN (espejo invertido). Usa los montos de la propia fila refund. */
function buildRefundLines(
  p: PaymentRow,
  acct: (m: string) => string,
): { lines: { ledgerAccountId: string; debitCents: number; creditCents: number }[] } | null {
  const rG = Math.abs(toCents(p.amount))
  const rT = Math.abs(toCents(p.tipAmount))
  const rF = Math.abs(toCents(p.feeAmount)) // normalmente 0: el procesador conserva la comisión
  const { netCents, taxCents } = splitIvaIncluded(rG, IVA_RATE)
  const isCash = p.method === PaymentMethod.CASH
  const refundCents = rG + rT - rF
  if (refundCents < 0) return null

  const lines: { ledgerAccountId: string; debitCents: number; creditCents: number }[] = []
  if (netCents > 0) lines.push({ ledgerAccountId: acct('SALES_RETURN'), debitCents: netCents, creditCents: 0 })
  if (taxCents > 0) lines.push({ ledgerAccountId: acct('IVA_OUTPUT'), debitCents: taxCents, creditCents: 0 })
  if (rT > 0) lines.push({ ledgerAccountId: acct('TIPS_PAYABLE'), debitCents: rT, creditCents: 0 })
  if (refundCents > 0)
    lines.push({ ledgerAccountId: acct(isCash ? 'CASH_RECEIPT' : 'BANK_RECEIPT'), debitCents: 0, creditCents: refundCents })
  if (rF > 0) lines.push({ ledgerAccountId: acct('PROCESSOR_FEE'), debitCents: 0, creditCents: rF })
  return lines.length >= 2 ? { lines } : null
}

/** ¿El pago es elegible para auto-postear? (espejo de las exclusiones del read-model de ingresos). */
function isEligible(p: PaymentRow): boolean {
  if (p.type === PaymentType.TEST) return false // pagos de prueba no son contables
  if (p.type === PaymentType.ADJUSTMENT) return false // semántica ambigua → revisión manual
  if (p.method === PaymentMethod.CRYPTOCURRENCY) return false // no-MXN → manual (diferido)
  if (p.order && p.order.status === OrderStatus.CANCELLED) return false // orden cancelada → sin ingreso
  if (Math.abs(toCents(p.amount)) === 0 && Math.abs(toCents(p.tipAmount)) === 0) return false // nada que registrar
  return true
}

/**
 * Genera (o completa) las pólizas automáticas de los pagos COMPLETED de un local.
 * Idempotente: re-correr no duplica. Si falta algún mapeo, no postea y lo reporta.
 */
export async function generatePoliciesForVenue(
  venueId: string,
  opts: { period?: string; actorStaffId?: string | null } = {},
): Promise<GenerateResult> {
  const period = opts.period ?? null
  const base: GenerateResult = {
    needsFiscalSetup: false,
    missingMappings: [],
    period,
    candidates: 0,
    posted: 0,
    alreadyPosted: 0,
    skipped: 0,
  }

  const scope = await resolveScopeOrNull(venueId)
  if (!scope) return { ...base, needsFiscalSetup: true }

  // Mapeos movimiento→cuenta del contribuyente. Falta alguno requerido → no postear.
  const mapResult = await getMappings(venueId)
  const accountByMovement = new Map<string, string>()
  for (const m of mapResult.mappings) if (m.account) accountByMovement.set(m.movementType, m.account.id)
  const missing = REQUIRED_MOVEMENTS.filter(m => !accountByMovement.has(m))
  if (missing.length > 0) return { ...base, missingMappings: missing }
  const acct = (m: string): string => accountByMovement.get(m)!

  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  const tz = venue?.timezone || DEFAULT_TZ

  // Rango por periodo (tz-safe) si se pidió.
  let createdAt: { gte: Date; lte: Date } | undefined
  if (period) {
    if (!PERIOD_RE.test(period)) throw new Error('Periodo inválido')
    const [y, m] = period.split('-').map(Number)
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
    const { from, to } = parseDbDateRange(`${period}-01`, `${period}-${String(lastDay).padStart(2, '0')}`, tz)
    createdAt = { gte: from, lte: to }
  }

  const payments = (await prisma.payment.findMany({
    where: {
      venueId,
      status: TransactionStatus.COMPLETED,
      ...(createdAt ? { createdAt } : {}),
      order: { status: { not: OrderStatus.CANCELLED } },
    },
    select: {
      id: true,
      amount: true,
      tipAmount: true,
      feeAmount: true,
      method: true,
      type: true,
      createdAt: true,
      order: { select: { status: true, orderNumber: true } },
    },
    orderBy: { createdAt: 'asc' },
  })) as PaymentRow[]

  const eligible = payments.filter(isEligible)
  base.candidates = eligible.length
  base.skipped = payments.length - eligible.length // TEST/ajuste/cripto/cero (cancelados ya filtrados por la query)

  // Idempotencia: precarga las claves ya posteadas para no re-postear ni recontar.
  const keys = eligible.map(p => (p.type === PaymentType.REFUND ? `refund:${p.id}:v1` : `pay:${p.id}:v1`))
  const existing = new Set(
    (
      await prisma.journalEntry.findMany({
        where: { organizationId: scope.organizationId, rfc: scope.rfc, idempotencyKey: { in: keys } },
        select: { idempotencyKey: true },
      })
    ).map(e => e.idempotencyKey),
  )

  for (const p of eligible) {
    // Una devolución es type=REFUND O cualquier pago con monto NEGATIVO (voids/ajustes legacy que el
    // read-model de ingresos también resta). Enrutar por SIGNO evita contar un negativo como venta positiva.
    const isRefund = toCents(p.amount) < 0 || p.type === PaymentType.REFUND
    const key = isRefund ? `refund:${p.id}:v1` : `pay:${p.id}:v1`
    if (existing.has(key)) {
      base.alreadyPosted++
      continue
    }
    const built = isRefund ? buildRefundLines(p, acct) : buildSaleLines(p, acct)
    if (!built) {
      base.skipped++ // anomalía no balanceable (ej. comisión > cobro)
      continue
    }
    const date = formatInTimeZone(p.createdAt, tz, 'yyyy-MM-dd')
    const num = p.order?.orderNumber != null ? `#${p.order.orderNumber} ` : ''
    await postJournalEntry(
      venueId,
      {
        date,
        type: isRefund ? JournalEntryType.EGRESO : JournalEntryType.INGRESO,
        source: isRefund ? JournalEntrySource.REFUND : JournalEntrySource.PAYMENT,
        sourceId: p.id,
        idempotencyKey: key,
        concept: `${isRefund ? 'Devolución' : 'Venta'} ${num}· ${p.method}`,
        venueId,
        lines: built.lines,
      },
      { staffId: opts.actorStaffId ?? null },
    )
    base.posted++
  }

  return base
}
