import prisma from '../../utils/prismaClient'
import { BadRequestError } from '../../errors/AppError'
import { resolveScopeOrNull } from './chartOfAccounts.service'

/**
 * Cuentas por pagar (CxP) — antigüedad de saldos a proveedores. Read-model sobre el Buzón (Expense).
 *
 * Responde "¿a quién le debo, cuánto y desde cuándo?": agrupa por proveedor los CFDIs recibidos
 * (INGRESO, no cancelados) con saldo pendiente (total − pagado > 0) y reparte ese saldo en cubetas
 * de antigüedad por días desde la EMISIÓN (0-30 / 31-60 / 61-90 / 90+). Es por contribuyente
 * (org, rfc), sumando todos los locales del RFC. Sólo lectura. Gated PREMIUM (CFDI).
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export interface SupplierAgingRow {
  proveedorRfc: string
  proveedorNombre: string
  comprobantes: number
  pendienteCents: number
  corrienteCents: number // 0-30 días
  d31_60Cents: number
  d61_90Cents: number
  mas90Cents: number
  /** Comprobante más antiguo con saldo (días desde emisión). */
  maxDiasVencido: number
}

export interface AccountsPayableResult {
  needsFiscalSetup: boolean
  organizationId: string | null
  rfc: string | null
  asOf: string
  suppliers: SupplierAgingRow[]
  totals: {
    proveedores: number
    comprobantes: number
    pendienteCents: number
    corrienteCents: number
    d31_60Cents: number
    d61_90Cents: number
    mas90Cents: number
  }
}

const emptyTotals = () => ({
  proveedores: 0,
  comprobantes: 0,
  pendienteCents: 0,
  corrienteCents: 0,
  d31_60Cents: 0,
  d61_90Cents: 0,
  mas90Cents: 0,
})

/** Cubeta de antigüedad de un saldo según los días transcurridos desde la emisión. */
type Bucket = 'corrienteCents' | 'd31_60Cents' | 'd61_90Cents' | 'mas90Cents'
function bucketOf(dias: number): Bucket {
  if (dias <= 30) return 'corrienteCents'
  if (dias <= 60) return 'd31_60Cents'
  if (dias <= 90) return 'd61_90Cents'
  return 'mas90Cents'
}

/**
 * Antigüedad de saldos de proveedores (CxP) a la fecha `asOf` (default hoy). Devuelve
 * `needsFiscalSetup` si el local no tiene RFC. Los proveedores se ordenan por saldo descendente.
 */
export async function getAccountsPayableAging(venueId: string, asOf?: string): Promise<AccountsPayableResult> {
  if (asOf && !DATE_RE.test(asOf)) throw new BadRequestError('La fecha debe tener formato AAAA-MM-DD.')
  // Ancla a mediodía UTC para que el día no se corra por la zona horaria del host (ver datetime rules).
  const asOfDate = asOf ? new Date(`${asOf}T12:00:00.000Z`) : new Date()
  // El regex sólo valida dígitos; '2026-13-99' pasa pero es Invalid Date → valida el calendario real.
  if (Number.isNaN(asOfDate.getTime())) throw new BadRequestError('La fecha (asOf) no es una fecha válida del calendario.')
  const asOfStr = asOfDate.toISOString().slice(0, 10)

  const scope = await resolveScopeOrNull(venueId)
  if (!scope) {
    return { needsFiscalSetup: true, organizationId: null, rfc: null, asOf: asOfStr, suppliers: [], totals: emptyTotals() }
  }

  const expenses = await prisma.expense.findMany({
    where: {
      organizationId: scope.organizationId,
      rfc: scope.rfc,
      status: 'REGISTERED',
      comprobanteTipo: 'INGRESO',
      paymentStatus: { in: ['UNPAID', 'PARTIALLY_PAID'] },
    },
    select: { proveedorRfc: true, proveedorNombre: true, totalCents: true, paidCents: true, fechaEmision: true },
  })

  const byRfc = new Map<string, SupplierAgingRow>()
  for (const e of expenses) {
    const pendiente = e.totalCents - e.paidCents
    if (pendiente <= 0) continue // defensivo: PAID parcial que ya cubre el total

    const dias = Math.max(0, Math.floor((asOfDate.getTime() - e.fechaEmision.getTime()) / 86_400_000))
    const bucket = bucketOf(dias)

    let row = byRfc.get(e.proveedorRfc)
    if (!row) {
      row = {
        proveedorRfc: e.proveedorRfc,
        proveedorNombre: e.proveedorNombre,
        comprobantes: 0,
        pendienteCents: 0,
        corrienteCents: 0,
        d31_60Cents: 0,
        d61_90Cents: 0,
        mas90Cents: 0,
        maxDiasVencido: 0,
      }
      byRfc.set(e.proveedorRfc, row)
    }
    row.comprobantes += 1
    row.pendienteCents += pendiente
    row[bucket] += pendiente
    if (dias > row.maxDiasVencido) row.maxDiasVencido = dias
  }

  const suppliers = [...byRfc.values()].sort((a, b) => b.pendienteCents - a.pendienteCents)
  const totals = suppliers.reduce((t, s) => {
    t.proveedores += 1
    t.comprobantes += s.comprobantes
    t.pendienteCents += s.pendienteCents
    t.corrienteCents += s.corrienteCents
    t.d31_60Cents += s.d31_60Cents
    t.d61_90Cents += s.d61_90Cents
    t.mas90Cents += s.mas90Cents
    return t
  }, emptyTotals())

  return { needsFiscalSetup: false, organizationId: scope.organizationId, rfc: scope.rfc, asOf: asOfStr, suppliers, totals }
}
