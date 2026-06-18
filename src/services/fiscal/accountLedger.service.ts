import { JournalEntryStatus, LedgerAccountNature, LedgerAccountType } from '@prisma/client'

import { BadRequestError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { resolveScopeOrNull } from './chartOfAccounts.service'

/**
 * Auxiliar de cuenta (libro mayor por cuenta, Capa B) — read-model derivado de las pólizas.
 *
 * Es el DRILL-DOWN natural desde la balanza: para UNA cuenta en un periodo (YYYY-MM) lista el saldo
 * inicial (acumulado de periodos anteriores), cada movimiento (fecha, folio, concepto, cargo, abono)
 * con su SALDO CORRIDO, y el saldo final. Mismo universo que la balanza (sólo pólizas POSTED), así
 * que el saldo final del auxiliar == el saldo final de la cuenta en la balanza. No persiste nada;
 * se calcula al vuelo. Money en centavos enteros. Gated PREMIUM (CFDI).
 *
 * Convención de saldo: NETO "cargo − abono" (positivo = deudor), igual que `trialBalance.service`.
 */

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/

export interface AccountLedgerMovement {
  date: string
  folio: number
  /** Tipo/origen de la póliza (informativo). */
  source: string
  concept: string
  /** Descripción de la línea (si la trae); si no, hereda el concepto de la póliza. */
  description: string | null
  debitCents: number
  creditCents: number
  /** Saldo NETO corrido tras aplicar este movimiento (+ = deudor). */
  saldoCents: number
}

export interface AccountLedgerResult {
  needsFiscalSetup: boolean
  /** La cuenta no existe en el catálogo del contribuyente. */
  notFound: boolean
  organizationId: string | null
  rfc: string | null
  period: string
  account: { code: string; name: string; type: LedgerAccountType; nature: LedgerAccountNature } | null
  saldoInicialCents: number
  totalDebeCents: number
  totalHaberCents: number
  saldoFinalCents: number
  movements: AccountLedgerMovement[]
}

const emptyResult = (
  period: string,
  rfc: string | null,
  organizationId: string | null,
  over: Partial<AccountLedgerResult> = {},
): AccountLedgerResult => ({
  needsFiscalSetup: false,
  notFound: false,
  organizationId,
  rfc,
  period,
  account: null,
  saldoInicialCents: 0,
  totalDebeCents: 0,
  totalHaberCents: 0,
  saldoFinalCents: 0,
  movements: [],
  ...over,
})

/**
 * Auxiliar de la cuenta `accountCode` para el periodo. Devuelve `needsFiscalSetup` si el local no
 * tiene RFC, `notFound` si la cuenta no existe en su catálogo.
 */
export async function getAccountLedger(venueId: string, accountCode: string, period: string): Promise<AccountLedgerResult> {
  if (!PERIOD_RE.test(period)) throw new BadRequestError('El periodo debe tener formato AAAA-MM.')
  const code = accountCode.trim()
  if (!code) throw new BadRequestError('El código de la cuenta es requerido.')

  const scope = await resolveScopeOrNull(venueId)
  if (!scope) return emptyResult(period, null, null, { needsFiscalSetup: true })

  const account = await prisma.ledgerAccount.findUnique({
    where: { organizationId_rfc_code: { organizationId: scope.organizationId, rfc: scope.rfc, code } },
    select: { id: true, code: true, name: true, type: true, nature: true },
  })
  if (!account) return emptyResult(period, scope.rfc, scope.organizationId, { notFound: true })

  const base = { organizationId: scope.organizationId, rfc: scope.rfc, status: JournalEntryStatus.POSTED }

  const [before, lines] = await Promise.all([
    // Saldo inicial = acumulado neto de periodos anteriores (comparación de cadenas YYYY-MM = cronológica).
    prisma.journalLine.aggregate({
      where: { ledgerAccountId: account.id, journalEntry: { ...base, period: { lt: period } } },
      _sum: { debitCents: true, creditCents: true },
    }),
    // Movimientos del periodo, en orden cronológico (fecha, folio, y luego orden de captura).
    prisma.journalLine.findMany({
      where: { ledgerAccountId: account.id, journalEntry: { ...base, period } },
      include: { journalEntry: { select: { date: true, folio: true, concept: true, source: true } } },
      orderBy: [{ journalEntry: { date: 'asc' } }, { journalEntry: { folio: 'asc' } }, { createdAt: 'asc' }],
    }),
  ])

  const saldoInicialCents = (before._sum.debitCents ?? 0) - (before._sum.creditCents ?? 0)

  let saldo = saldoInicialCents
  let totalDebe = 0
  let totalHaber = 0
  const movements: AccountLedgerMovement[] = lines.map(l => {
    saldo += l.debitCents - l.creditCents
    totalDebe += l.debitCents
    totalHaber += l.creditCents
    return {
      date: l.journalEntry.date.toISOString().slice(0, 10),
      folio: l.journalEntry.folio,
      source: l.journalEntry.source,
      concept: l.journalEntry.concept,
      description: l.description,
      debitCents: l.debitCents,
      creditCents: l.creditCents,
      saldoCents: saldo,
    }
  })

  return {
    needsFiscalSetup: false,
    notFound: false,
    organizationId: scope.organizationId,
    rfc: scope.rfc,
    period,
    account: { code: account.code, name: account.name, type: account.type, nature: account.nature },
    saldoInicialCents,
    totalDebeCents: totalDebe,
    totalHaberCents: totalHaber,
    saldoFinalCents: saldo,
    movements,
  }
}
