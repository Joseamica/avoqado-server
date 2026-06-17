import { JournalEntryStatus, LedgerAccountType } from '@prisma/client'

import { BadRequestError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { resolveScopeOrNull } from './chartOfAccounts.service'

/**
 * Reportes contables (Capa B) — read-models sobre las pólizas.
 *
 *  - **Estado de resultados** (P&L) del EJERCICIO al periodo: ingresos − costos − gastos =
 *    resultado (utilidad/pérdida). Las cuentas de resultados se acumulan del inicio del año
 *    fiscal (YYYY-01) al periodo.
 *  - **Balance general** al cierre del periodo: activo = pasivo + capital, donde el capital
 *    incluye el "resultado del ejercicio" (aún no cerrado). La ecuación contable es la PRUEBA
 *    de cuadre — se cumple porque toda póliza está balanceada.
 *
 * No persiste nada; se calcula al vuelo desde JournalLine. Money en centavos enteros. Gated PREMIUM.
 */

const PERIOD_RE = /^\d{4}-\d{2}$/

export interface ReportLine {
  code: string
  name: string
  /** Monto en positivo (ya orientado por la naturaleza de la cuenta). */
  amountCents: number
}

export interface IncomeStatement {
  ingresos: { lines: ReportLine[]; totalCents: number }
  costos: { lines: ReportLine[]; totalCents: number }
  utilidadBrutaCents: number
  gastos: { lines: ReportLine[]; totalCents: number }
  /** Resultado del ejercicio: > 0 utilidad, < 0 pérdida. */
  resultadoCents: number
}

export interface BalanceSheet {
  activo: { lines: ReportLine[]; totalCents: number }
  pasivo: { lines: ReportLine[]; totalCents: number }
  /** Incluye una línea "Resultado del ejercicio" para que cuadre la ecuación. */
  capital: { lines: ReportLine[]; totalCents: number }
  resultadoEjercicioCents: number
  /** activo == pasivo + capital (la ecuación contable). */
  balanced: boolean
}

export interface AccountingReportsResult {
  needsFiscalSetup: boolean
  organizationId: string | null
  rfc: string | null
  period: string
  fiscalYearStart: string
  incomeStatement: IncomeStatement
  balanceSheet: BalanceSheet
}

const RESULT_TYPES = new Set<LedgerAccountType>([LedgerAccountType.INGRESO, LedgerAccountType.COSTO, LedgerAccountType.GASTO])
const BALANCE_TYPES = new Set<LedgerAccountType>([LedgerAccountType.ACTIVO, LedgerAccountType.PASIVO, LedgerAccountType.CAPITAL])

const emptyReports = (period: string, scope: { organizationId: string; rfc: string } | null): AccountingReportsResult => ({
  needsFiscalSetup: scope === null,
  organizationId: scope?.organizationId ?? null,
  rfc: scope?.rfc ?? null,
  period,
  fiscalYearStart: `${period.slice(0, 4)}-01`,
  incomeStatement: {
    ingresos: { lines: [], totalCents: 0 },
    costos: { lines: [], totalCents: 0 },
    utilidadBrutaCents: 0,
    gastos: { lines: [], totalCents: 0 },
    resultadoCents: 0,
  },
  balanceSheet: {
    activo: { lines: [], totalCents: 0 },
    pasivo: { lines: [], totalCents: 0 },
    capital: { lines: [], totalCents: 0 },
    resultadoEjercicioCents: 0,
    balanced: true,
  },
})

/**
 * Estado de resultados (del ejercicio al periodo) + Balance general (al cierre del periodo).
 */
export async function getAccountingReports(venueId: string, period: string): Promise<AccountingReportsResult> {
  if (!PERIOD_RE.test(period)) throw new BadRequestError('El periodo debe tener formato AAAA-MM.')

  const scope = await resolveScopeOrNull(venueId)
  if (!scope) return emptyReports(period, null)

  const fiscalYearStart = `${period.slice(0, 4)}-01`
  const base = { organizationId: scope.organizationId, rfc: scope.rfc, status: JournalEntryStatus.POSTED }

  // Resultados = del año fiscal al periodo; Balance = acumulado de todo hasta el periodo.
  const [ytdAgg, allAgg] = await Promise.all([
    prisma.journalLine.groupBy({
      by: ['ledgerAccountId'],
      where: { journalEntry: { ...base, period: { gte: fiscalYearStart, lte: period } } },
      _sum: { debitCents: true, creditCents: true },
    }),
    prisma.journalLine.groupBy({
      by: ['ledgerAccountId'],
      where: { journalEntry: { ...base, period: { lte: period } } },
      _sum: { debitCents: true, creditCents: true },
    }),
  ])

  const ytdById = new Map(ytdAgg.map(g => [g.ledgerAccountId, g._sum]))
  const allById = new Map(allAgg.map(g => [g.ledgerAccountId, g._sum]))
  const accountIds = [...new Set([...ytdById.keys(), ...allById.keys()])]
  if (accountIds.length === 0) return emptyReports(period, scope)

  const accounts = await prisma.ledgerAccount.findMany({
    where: { id: { in: accountIds }, organizationId: scope.organizationId, rfc: scope.rfc },
    select: { id: true, code: true, name: true, type: true },
  })

  const ingresos: ReportLine[] = []
  const costos: ReportLine[] = []
  const gastos: ReportLine[] = []
  const activo: ReportLine[] = []
  const pasivo: ReportLine[] = []
  const capital: ReportLine[] = []

  for (const a of accounts) {
    if (RESULT_TYPES.has(a.type)) {
      const s = ytdById.get(a.id)
      const debe = s?.debitCents ?? 0
      const haber = s?.creditCents ?? 0
      if (a.type === LedgerAccountType.INGRESO) {
        const amount = haber - debe // acreedora → ingreso positivo
        if (amount !== 0) ingresos.push({ code: a.code, name: a.name, amountCents: amount })
      } else if (a.type === LedgerAccountType.COSTO) {
        const amount = debe - haber // deudora
        if (amount !== 0) costos.push({ code: a.code, name: a.name, amountCents: amount })
      } else {
        const amount = debe - haber
        if (amount !== 0) gastos.push({ code: a.code, name: a.name, amountCents: amount })
      }
    } else if (BALANCE_TYPES.has(a.type)) {
      const s = allById.get(a.id)
      const debe = s?.debitCents ?? 0
      const haber = s?.creditCents ?? 0
      if (a.type === LedgerAccountType.ACTIVO) {
        const amount = debe - haber // deudora
        if (amount !== 0) activo.push({ code: a.code, name: a.name, amountCents: amount })
      } else if (a.type === LedgerAccountType.PASIVO) {
        const amount = haber - debe // acreedora
        if (amount !== 0) pasivo.push({ code: a.code, name: a.name, amountCents: amount })
      } else {
        const amount = haber - debe
        if (amount !== 0) capital.push({ code: a.code, name: a.name, amountCents: amount })
      }
    }
    // ORDEN: no entra a estados financieros.
  }

  const sum = (l: ReportLine[]) => l.reduce((s, x) => s + x.amountCents, 0)
  const byCode = (l: ReportLine[]) => l.sort((x, y) => x.code.localeCompare(y.code))

  const ingresosTotal = sum(ingresos)
  const costosTotal = sum(costos)
  const gastosTotal = sum(gastos)
  const utilidadBruta = ingresosTotal - costosTotal
  const resultado = utilidadBruta - gastosTotal

  // El resultado del ejercicio se suma al capital (aún no cerrado) para cuadrar la ecuación.
  const capitalLines = [...byCode(capital), { code: '~RESULT', name: 'Resultado del ejercicio', amountCents: resultado }]
  const activoTotal = sum(activo)
  const pasivoTotal = sum(pasivo)
  const capitalTotal = sum(capital) + resultado

  return {
    needsFiscalSetup: false,
    organizationId: scope.organizationId,
    rfc: scope.rfc,
    period,
    fiscalYearStart,
    incomeStatement: {
      ingresos: { lines: byCode(ingresos), totalCents: ingresosTotal },
      costos: { lines: byCode(costos), totalCents: costosTotal },
      utilidadBrutaCents: utilidadBruta,
      gastos: { lines: byCode(gastos), totalCents: gastosTotal },
      resultadoCents: resultado,
    },
    balanceSheet: {
      activo: { lines: byCode(activo), totalCents: activoTotal },
      pasivo: { lines: byCode(pasivo), totalCents: pasivoTotal },
      capital: { lines: capitalLines, totalCents: capitalTotal },
      resultadoEjercicioCents: resultado,
      balanced: activoTotal === pasivoTotal + capitalTotal,
    },
  }
}
