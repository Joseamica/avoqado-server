import { JournalEntrySource, JournalEntryType, type Expense } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'

import { BadRequestError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { logAction } from '../dashboard/activity-log.service'
import { getMappings } from './accountMapping.service'
import { resolveScopeOrNull } from './chartOfAccounts.service'
import { postJournalEntry } from './journalEntry.service'

/**
 * Motor de pólizas de GASTOS (CFDIs recibidos) — Capa B, lado de entradas.
 *
 * Espejo de autoPosting (ventas). Dicta el asiento de partida doble de cada gasto a partir de su
 * desglose fiscal y de los mapeos del contribuyente (AccountMapping). Cash-basis: el IVA se
 * acredita cuando se PAGA (118.01 si pagado, 119.01 pendiente si a crédito). El cuadre se logra
 * POR CONSTRUCCIÓN: la cuenta que paga / Proveedores recibe el total y cualquier residuo de
 * redondeo (≤1¢) va a 703 — postJournalEntry rechaza si Σdebe≠Σhaber. Gated PREMIUM (CFDI).
 */

const DEFAULT_TZ = 'America/Mexico_City'
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/

/** Subconjunto de Expense que el plan necesita (todo lo demás es metadata). */
type ExpenseForPlan = Pick<
  Expense,
  | 'comprobanteTipo'
  | 'subtotalCents'
  | 'descuentoCents'
  | 'ivaCents'
  | 'iepsCents'
  | 'isrRetenidoCents'
  | 'ivaRetenidoCents'
  | 'totalCents'
  | 'deducible'
  | 'ivaAcreditable'
  | 'paymentStatus'
  | 'formaPago'
  | 'categoria'
  | 'ledgerAccountId'
>

interface PlanLine {
  movement: string
  debitCents: number
  creditCents: number
}

interface ExpensePlan {
  lines: PlanLine[]
  /** Movimientos (códigos) que la póliza referencia — para el chequeo de mapeos faltantes. */
  movements: string[]
  /** El comprobante no es balanceable con ≤1¢ de redondeo (anomalía estructural). */
  unbalanceable: boolean
  /** No-null ⇒ NO postear este comprobante (caso aún no soportado en v1); el texto explica por qué. */
  skipReason: string | null
}

/** Forma de pago '01' = efectivo (catálogo SAT). Cualquier otra ⇒ banco. */
function isCashForma(formaPago: string | null): boolean {
  return (formaPago ?? '').trim() === '01'
}

/** Cuenta del gasto según la categoría (reasignable vía AccountMapping; las cuentas ya existen). */
function expenseMovementFor(categoria: string): string {
  switch (categoria) {
    case 'COSTO_MERCANCIA':
      return 'COST_OF_GOODS_SOLD'
    case 'ARRENDAMIENTO':
      return 'EXPENSE_RENT'
    case 'COMBUSTIBLE':
      return 'EXPENSE_FUEL'
    default:
      // GASTO_GENERAL / HONORARIOS / SERVICIOS / OTRO → 601.84 (las retenciones de honorarios
      // se manejan en sus propias líneas 216.x sin importar la cuenta del gasto).
      return 'EXPENSE_GENERAL'
  }
}

/**
 * Dicta el asiento en ESPACIO DE MOVIMIENTOS (sin resolver cuentas todavía). El cuadre se garantiza
 * por construcción: la cuenta que paga/Proveedores toma el total y el residuo (≤1¢) va a redondeo.
 *
 * Sólo postea comprobantes de tipo INGRESO (un gasto). Las notas de crédito (EGRESO), los REP (PAGO)
 * y nómina/traslado NO son un gasto a debitar — postearlos como tal invertiría/duplicaría el IVA
 * acreditable y la DIOT, así que se SALTAN con skipReason (su asiento propio es trabajo posterior).
 * Cash-basis: PAID ⇒ IVA a 118.01 ahora; UNPAID/PARTIALLY_PAID ⇒ devengo (119.01 pendiente, contra
 * Proveedores) y el IVA se acreditará al pagar (REP, slice posterior). En v1 createExpense sólo
 * produce PAID o UNPAID; el prorrateo de parcialidades queda diferido.
 */
export function planExpenseEntry(e: ExpenseForPlan): ExpensePlan {
  const empty = { lines: [] as PlanLine[], movements: [] as string[], unbalanceable: false }
  if (e.comprobanteTipo !== 'INGRESO') {
    return { ...empty, skipReason: `Comprobante tipo ${e.comprobanteTipo} aún no soportado para póliza automática (v1 sólo INGRESO).` }
  }

  const acreditable = e.deducible && e.ivaAcreditable
  const gastoBase = e.subtotalCents - e.descuentoCents + e.iepsCents
  // IVA no acreditable ⇒ se va al COSTO del gasto, NO a 118.01/119.01 (MUST-FIX).
  const gastoDebit = gastoBase + (acreditable ? 0 : e.ivaCents)
  const ivaDebit = acreditable ? e.ivaCents : 0
  const isPaid = e.paymentStatus === 'PAID'

  const expenseMovement = expenseMovementFor(e.categoria)
  const ivaMovement = isPaid ? 'IVA_INPUT' : 'IVA_INPUT_PENDING'
  const payMovement = isPaid ? (isCashForma(e.formaPago) ? 'CASH_RECEIPT' : 'BANK_RECEIPT') : 'ACCOUNTS_PAYABLE'

  const lines: PlanLine[] = []
  let debitTotal = 0

  if (gastoDebit > 0) {
    lines.push({ movement: expenseMovement, debitCents: gastoDebit, creditCents: 0 })
    debitTotal += gastoDebit
  }
  if (ivaDebit > 0) {
    lines.push({ movement: ivaMovement, debitCents: ivaDebit, creditCents: 0 })
    debitTotal += ivaDebit
  }
  if (e.ivaRetenidoCents > 0) lines.push({ movement: 'IVA_WITHHELD', debitCents: 0, creditCents: e.ivaRetenidoCents })
  if (e.isrRetenidoCents > 0) lines.push({ movement: 'ISR_WITHHELD', debitCents: 0, creditCents: e.isrRetenidoCents })
  if (e.totalCents > 0) lines.push({ movement: payMovement, debitCents: 0, creditCents: e.totalCents })

  // Cuadre por construcción: residuo = Σdebe − (retenciones + total). Debe ser 0 (exacto) o ≤1¢.
  const residual = debitTotal - e.ivaRetenidoCents - e.isrRetenidoCents - e.totalCents
  if (residual !== 0) {
    if (Math.abs(residual) > 1) return { lines: [], movements: [], unbalanceable: true, skipReason: null }
    if (residual > 0) lines.push({ movement: 'ROUNDING_DIFFERENCE', debitCents: 0, creditCents: residual })
    else lines.push({ movement: 'ROUNDING_DIFFERENCE', debitCents: -residual, creditCents: 0 })
  }

  const movements = [...new Set(lines.map(l => l.movement))]
  return { lines, movements, unbalanceable: false, skipReason: null }
}

export interface GenerateExpenseResult {
  needsFiscalSetup: boolean
  /** Movimientos requeridos por algún gasto pero aún sin cuenta asignada. */
  missingMappings: string[]
  period: string | null
  candidates: number
  posted: number
  alreadyPosted: number
  /** Saltados: anomalía no balanceable o mapeo faltante para ese gasto. */
  skipped: number
}

interface PostedOutcome {
  status: 'posted' | 'alreadyPosted' | 'skipped'
  missing?: string[]
  journalEntryId?: string
}

/** Postea UN gasto (idempotente por `expense:<id>:v1`). Marca posted + journalEntryId. */
async function postOneExpense(
  venueId: string,
  expense: Expense,
  acct: (m: string) => string | undefined,
  tz: string,
  actorStaffId: string | null,
): Promise<PostedOutcome> {
  if (expense.posted) return { status: 'alreadyPosted' }

  const plan = planExpenseEntry(expense)
  if (plan.skipReason || plan.unbalanceable) return { status: 'skipped' }

  // Si el gasto tiene una cuenta explícita, esa manda para la línea del gasto.
  const missing = plan.movements.filter(m => {
    if (m === 'EXPENSE_GENERAL' || m === 'COST_OF_GOODS_SOLD') return expense.ledgerAccountId ? false : !acct(m)
    return !acct(m)
  })
  if (missing.length > 0) return { status: 'skipped', missing }

  const resolveAccountId = (m: string): string => {
    if ((m === 'EXPENSE_GENERAL' || m === 'COST_OF_GOODS_SOLD') && expense.ledgerAccountId) return expense.ledgerAccountId
    return acct(m)!
  }
  const lines = plan.lines.map(l => ({
    ledgerAccountId: resolveAccountId(l.movement),
    debitCents: l.debitCents,
    creditCents: l.creditCents,
  }))

  const date = formatInTimeZone(expense.fechaEmision, tz, 'yyyy-MM-dd')
  const ref = expense.uuid ? expense.uuid.slice(0, 8) : (expense.folio ?? '')
  const dto = await postJournalEntry(
    venueId,
    {
      date,
      type: JournalEntryType.EGRESO,
      source: JournalEntrySource.EXPENSE,
      sourceId: expense.id,
      idempotencyKey: `expense:${expense.id}:v1`,
      concept: `Gasto · ${expense.proveedorNombre}${ref ? ` · ${ref}` : ''}`,
      venueId,
      lines,
    },
    { staffId: actorStaffId },
  )

  await prisma.expense.update({ where: { id: expense.id }, data: { posted: true, journalEntryId: dto.id } })
  return { status: 'posted', journalEntryId: dto.id }
}

/**
 * Genera las pólizas de gastos del periodo (o de todos los gastos sin postear). No bloquea por un
 * mapeo faltante de UN gasto: lo salta y reporta el movimiento faltante; sigue con los demás.
 */
export async function generateExpensePoliciesForVenue(
  venueId: string,
  opts: { period?: string; actorStaffId?: string | null } = {},
): Promise<GenerateExpenseResult> {
  const period = opts.period ?? null
  const base: GenerateExpenseResult = {
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

  const mapResult = await getMappings(venueId)
  const accountByMovement = new Map<string, string>()
  for (const m of mapResult.mappings) if (m.account) accountByMovement.set(m.movementType, m.account.id)
  const acct = (m: string): string | undefined => accountByMovement.get(m)

  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  const tz = venue?.timezone || DEFAULT_TZ

  let fechaEmision: { gte: Date; lt: Date } | undefined
  if (period) {
    if (!PERIOD_RE.test(period)) throw new Error('Periodo inválido')
    const start = new Date(`${period}-01T00:00:00.000Z`)
    const end = new Date(start)
    end.setUTCMonth(end.getUTCMonth() + 1)
    fechaEmision = { gte: start, lt: end }
  }

  const expenses = await prisma.expense.findMany({
    // Sólo comprobantes de tipo INGRESO (un gasto) son candidatos. EGRESO (nota de crédito), PAGO
    // (REP) y nómina/traslado tienen otro asiento (o ninguno) y no deben postearse como gasto.
    where: {
      organizationId: scope.organizationId,
      rfc: scope.rfc,
      status: 'REGISTERED',
      posted: false,
      comprobanteTipo: 'INGRESO',
      ...(fechaEmision ? { fechaEmision } : {}),
    },
    orderBy: { fechaEmision: 'asc' },
  })
  base.candidates = expenses.length

  const missingSet = new Set<string>()
  for (const e of expenses) {
    const outcome = await postOneExpense(venueId, e, acct, tz, opts.actorStaffId ?? null)
    if (outcome.status === 'posted') base.posted++
    else if (outcome.status === 'alreadyPosted') base.alreadyPosted++
    else {
      base.skipped++
      outcome.missing?.forEach(m => missingSet.add(m))
    }
  }
  base.missingMappings = [...missingSet]
  return base
}

/** Postea un único gasto por id (usado tras captura / desde el MCP). */
export async function postExpensePolicy(
  venueId: string,
  expenseId: string,
  actor: { staffId?: string | null },
): Promise<GenerateExpenseResult> {
  const base: GenerateExpenseResult = {
    needsFiscalSetup: false,
    missingMappings: [],
    period: null,
    candidates: 0,
    posted: 0,
    alreadyPosted: 0,
    skipped: 0,
  }

  const scope = await resolveScopeOrNull(venueId)
  if (!scope) return { ...base, needsFiscalSetup: true }

  const expense = await prisma.expense.findFirst({
    where: { id: expenseId, organizationId: scope.organizationId, rfc: scope.rfc, status: 'REGISTERED' },
  })
  if (!expense) return base // no existe / cancelado / otro contribuyente
  base.candidates = 1

  const mapResult = await getMappings(venueId)
  const accountByMovement = new Map<string, string>()
  for (const m of mapResult.mappings) if (m.account) accountByMovement.set(m.movementType, m.account.id)
  const acct = (m: string): string | undefined => accountByMovement.get(m)

  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  const tz = venue?.timezone || DEFAULT_TZ

  const outcome = await postOneExpense(venueId, expense, acct, tz, actor.staffId ?? null)
  if (outcome.status === 'posted') base.posted++
  else if (outcome.status === 'alreadyPosted') base.alreadyPosted++
  else {
    base.skipped++
    base.missingMappings = outcome.missing ?? []
  }
  return base
}

/** Líneas de la póliza de PAGO de un gasto PPD ya devengado: 201.01→banco/caja, 119.01→118.01. */
export function planExpensePayment(e: ExpenseForPlan): { lines: PlanLine[]; movements: string[] } {
  const acreditable = e.deducible && e.ivaAcreditable
  const payMovement = isCashForma(e.formaPago) ? 'CASH_RECEIPT' : 'BANK_RECEIPT'
  const lines: PlanLine[] = []
  // Pagamos a Proveedores el total (ya neto de retenciones, que se enteraron en el devengo).
  lines.push({ movement: 'ACCOUNTS_PAYABLE', debitCents: e.totalCents, creditCents: 0 })
  lines.push({ movement: payMovement, debitCents: 0, creditCents: e.totalCents })
  if (acreditable && e.ivaCents > 0) {
    // El IVA pasa de pendiente (119.01) a acreditable (118.01).
    lines.push({ movement: 'IVA_INPUT', debitCents: e.ivaCents, creditCents: 0 })
    lines.push({ movement: 'IVA_INPUT_PENDING', debitCents: 0, creditCents: e.ivaCents })
  }
  return { lines, movements: [...new Set(lines.map(l => l.movement))] }
}

export interface MarkPaidResult {
  needsFiscalSetup: boolean
  notFound: boolean
  alreadyPaid: boolean
  marked: boolean
  /** Se posteó la póliza de pago (sólo si el gasto ya estaba devengado/posteado). */
  paymentPosted: boolean
  missingMappings: string[]
}

/**
 * Marca un gasto como PAGADO (cash-basis): registra fechaPago/paidPeriod/paidCents y, si el gasto ya
 * estaba posteado en DEVENGO (caso PPD), postea la póliza de PAGO (201.01→banco, 119.01→118.01). Si
 * aún no se había posteado, sólo flipa el estado y la próxima generación lo postea como PAGADO directo.
 * Idempotente por `expense-pay:<id>:v1`.
 */
export async function markExpensePaid(
  venueId: string,
  expenseId: string,
  opts: { fechaPago: string; formaPago?: string | null },
  actor: { staffId?: string | null },
): Promise<MarkPaidResult> {
  const base: MarkPaidResult = { needsFiscalSetup: false, notFound: false, alreadyPaid: false, marked: false, paymentPosted: false, missingMappings: [] }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.fechaPago)) throw new BadRequestError('La fecha de pago debe tener formato AAAA-MM-DD.')

  const scope = await resolveScopeOrNull(venueId)
  if (!scope) return { ...base, needsFiscalSetup: true }

  const expense = await prisma.expense.findFirst({
    where: { id: expenseId, organizationId: scope.organizationId, rfc: scope.rfc, status: 'REGISTERED' },
  })
  if (!expense) return { ...base, notFound: true }
  if (expense.paymentStatus === 'PAID') return { ...base, alreadyPaid: true }

  const paidPeriod = opts.fechaPago.slice(0, 7)
  const formaPago = opts.formaPago ?? expense.formaPago

  await prisma.expense.update({
    where: { id: expense.id },
    data: { paymentStatus: 'PAID', fechaPago: new Date(`${opts.fechaPago}T12:00:00.000Z`), paidPeriod, paidCents: expense.totalCents, formaPago },
  })
  base.marked = true

  // Si el gasto YA estaba posteado en devengo (PPD), postea ahora la póliza de pago.
  if (expense.posted) {
    const mapResult = await getMappings(venueId)
    const accountByMovement = new Map<string, string>()
    for (const m of mapResult.mappings) if (m.account) accountByMovement.set(m.movementType, m.account.id)
    const acct = (m: string): string | undefined => accountByMovement.get(m)

    const { lines, movements } = planExpensePayment({ ...expense, formaPago })
    const missing = movements.filter(m => !acct(m))
    if (missing.length > 0) {
      base.missingMappings = missing
    } else {
      const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
      const tz = venue?.timezone || DEFAULT_TZ
      const ref = expense.uuid ? expense.uuid.slice(0, 8) : (expense.folio ?? '')
      await postJournalEntry(
        venueId,
        {
          date: formatInTimeZone(new Date(`${opts.fechaPago}T12:00:00.000Z`), tz, 'yyyy-MM-dd'),
          type: JournalEntryType.EGRESO,
          source: JournalEntrySource.EXPENSE,
          sourceId: expense.id,
          idempotencyKey: `expense-pay:${expense.id}:v1`,
          concept: `Pago gasto · ${expense.proveedorNombre}${ref ? ` · ${ref}` : ''}`,
          venueId,
          lines: lines.map(l => ({ ledgerAccountId: acct(l.movement)!, debitCents: l.debitCents, creditCents: l.creditCents })),
        },
        { staffId: actor.staffId ?? null },
      )
      base.paymentPosted = true
    }
  }

  await logAction({
    action: 'EXPENSE_MARKED_PAID',
    entity: 'Expense',
    entityId: expense.id,
    staffId: actor.staffId ?? null,
    venueId,
    data: { proveedorRfc: expense.proveedorRfc, totalCents: expense.totalCents, paidPeriod, paymentPosted: base.paymentPosted },
  })

  return base
}
