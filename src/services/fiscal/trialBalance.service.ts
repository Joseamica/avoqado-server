import { JournalEntryStatus, LedgerAccountNature, LedgerAccountType } from '@prisma/client'

import { BadRequestError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { resolveScopeOrNull } from './chartOfAccounts.service'

/**
 * Balanza de comprobación (Capa B) — read-model derivado de las pólizas.
 *
 * Para un periodo (YYYY-MM) agrega los JournalLine por cuenta: saldo inicial (acumulado de
 * periodos anteriores), cargos y abonos del periodo, y saldo final. Es la PRUEBA de que los
 * libros cuadran: Σcargos == Σabonos (los movimientos) y Σsaldo-deudor == Σsaldo-acreedor.
 * No persiste nada (los saldos al cierre por snapshot — AccountPeriodBalance — son una mejora
 * posterior); hoy se calcula al vuelo desde JournalLine. Money en centavos enteros. Gated PREMIUM.
 *
 * Convención: saldos en NETO con signo "cargo − abono" (positivo = saldo deudor, negativo =
 * acreedor). La UI los reparte en columnas deudor/acreedor según el signo.
 */

const PERIOD_RE = /^\d{4}-\d{2}$/

export interface TrialBalanceRow {
  code: string
  name: string
  type: LedgerAccountType
  nature: LedgerAccountNature
  /** Saldo inicial NETO (cargo − abono) acumulado de periodos anteriores. + = deudor. */
  saldoInicialCents: number
  debeCents: number
  haberCents: number
  /** Saldo final NETO = inicial + cargos − abonos. */
  saldoFinalCents: number
}

export interface TrialBalanceResult {
  needsFiscalSetup: boolean
  organizationId: string | null
  rfc: string | null
  period: string
  rows: TrialBalanceRow[]
  totals: {
    debeCents: number
    haberCents: number
    saldoInicialDeudorCents: number
    saldoInicialAcreedorCents: number
    saldoFinalDeudorCents: number
    saldoFinalAcreedorCents: number
  }
  /** La balanza "cuadra" si los movimientos y los saldos están balanceados. */
  balanced: { movements: boolean; balances: boolean }
}

/** YYYY-MM del mes actual (default cuando no se pasa periodo). */
export function currentPeriod(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * Balanza de comprobación del periodo. Agrega JournalLine por cuenta (saldo inicial de los
 * periodos anteriores + cargos/abonos del periodo) y arma los totales + el cuadre.
 */
export async function getTrialBalance(venueId: string, period: string): Promise<TrialBalanceResult> {
  if (!PERIOD_RE.test(period)) throw new BadRequestError('El periodo debe tener formato AAAA-MM.')

  const scope = await resolveScopeOrNull(venueId)
  if (!scope) {
    return {
      needsFiscalSetup: true,
      organizationId: null,
      rfc: null,
      period,
      rows: [],
      totals: {
        debeCents: 0,
        haberCents: 0,
        saldoInicialDeudorCents: 0,
        saldoInicialAcreedorCents: 0,
        saldoFinalDeudorCents: 0,
        saldoFinalAcreedorCents: 0,
      },
      balanced: { movements: true, balances: true },
    }
  }

  const base = { organizationId: scope.organizationId, rfc: scope.rfc, status: JournalEntryStatus.POSTED }

  // Movimientos del periodo + acumulado anterior (period < target; comparación de cadenas YYYY-MM = cronológica).
  const [periodAgg, beforeAgg] = await Promise.all([
    prisma.journalLine.groupBy({
      by: ['ledgerAccountId'],
      where: { journalEntry: { ...base, period } },
      _sum: { debitCents: true, creditCents: true },
    }),
    prisma.journalLine.groupBy({
      by: ['ledgerAccountId'],
      where: { journalEntry: { ...base, period: { lt: period } } },
      _sum: { debitCents: true, creditCents: true },
    }),
  ])

  const periodById = new Map(periodAgg.map(g => [g.ledgerAccountId, g._sum]))
  const beforeById = new Map(beforeAgg.map(g => [g.ledgerAccountId, g._sum]))
  const accountIds = [...new Set([...periodById.keys(), ...beforeById.keys()])]
  if (accountIds.length === 0) {
    return {
      needsFiscalSetup: false,
      organizationId: scope.organizationId,
      rfc: scope.rfc,
      period,
      rows: [],
      totals: {
        debeCents: 0,
        haberCents: 0,
        saldoInicialDeudorCents: 0,
        saldoInicialAcreedorCents: 0,
        saldoFinalDeudorCents: 0,
        saldoFinalAcreedorCents: 0,
      },
      balanced: { movements: true, balances: true },
    }
  }

  const accounts = await prisma.ledgerAccount.findMany({
    where: { id: { in: accountIds }, organizationId: scope.organizationId, rfc: scope.rfc },
    select: { id: true, code: true, name: true, type: true, nature: true },
  })

  const rows: TrialBalanceRow[] = []
  let debeTotal = 0
  let haberTotal = 0
  let iniDeudor = 0
  let iniAcreedor = 0
  let finDeudor = 0
  let finAcreedor = 0

  for (const a of accounts) {
    const per = periodById.get(a.id)
    const bef = beforeById.get(a.id)
    const debe = per?.debitCents ?? 0
    const haber = per?.creditCents ?? 0
    const saldoInicial = (bef?.debitCents ?? 0) - (bef?.creditCents ?? 0)
    const saldoFinal = saldoInicial + debe - haber

    rows.push({
      code: a.code,
      name: a.name,
      type: a.type,
      nature: a.nature,
      saldoInicialCents: saldoInicial,
      debeCents: debe,
      haberCents: haber,
      saldoFinalCents: saldoFinal,
    })

    debeTotal += debe
    haberTotal += haber
    if (saldoInicial >= 0) iniDeudor += saldoInicial
    else iniAcreedor += -saldoInicial
    if (saldoFinal >= 0) finDeudor += saldoFinal
    else finAcreedor += -saldoFinal
  }

  rows.sort((x, y) => x.code.localeCompare(y.code))

  return {
    needsFiscalSetup: false,
    organizationId: scope.organizationId,
    rfc: scope.rfc,
    period,
    rows,
    totals: {
      debeCents: debeTotal,
      haberCents: haberTotal,
      saldoInicialDeudorCents: iniDeudor,
      saldoInicialAcreedorCents: iniAcreedor,
      saldoFinalDeudorCents: finDeudor,
      saldoFinalAcreedorCents: finAcreedor,
    },
    balanced: { movements: debeTotal === haberTotal, balances: finDeudor === finAcreedor },
  }
}
