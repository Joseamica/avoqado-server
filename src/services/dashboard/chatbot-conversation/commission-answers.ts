/**
 * Lo que el asistente del dashboard contesta de comisiones (I2 de la revisión final, fase 3 «Pago al personal»).
 *
 * Desde octubre de 2026 las comisiones se pagan en el recibo de Pago al personal: lo pagado sale de esos recibos, la misma
 * fuente que el KPI «Pagado» de Comisiones (`comisionesPagadasEnRecibos`). Los estados «aprobado» y «pendiente» de los
 * resúmenes y de los pagos del flujo anterior ya nadie los escribe ni los puede completar (sus rutas responden 410), así que
 * el asistente no los dice. Lo que pagó el flujo anterior sigue siendo verdad y se nombra como historial. Es el hermano de lo
 * que E1c hizo en el MCP (`commission_payouts`).
 */
import { comisionesPagadasEnRecibos, getVenueCommissionStats } from '../commission/commission-calculation.service'
import { getPayouts, getPayoutStats } from '../commission/commission-payout.service'

export interface CommissionsSummary {
  /** Pagado en recibos de Pago al personal; 0 cuando la sede no lo usa (`staffPayActive: false`). */
  totalPaid: number
  staffPayActive: boolean
  totalCalculated: number
  /** Estados del flujo anterior: siguen en los datos por compatibilidad; el asistente no los dice. */
  totalPending: number
  totalApproved: number
  staffWithCommissions: number
  averageCommission: number
  topEarners: Array<{ staffName: string; totalEarned: number; calculationCount: number }>
}

export interface CommissionPayoutsSummary {
  /** Pagado en recibos de Pago al personal: la verdad de lo pagado desde octubre de 2026. */
  paidInStaffPay: number
  staffPayActive: boolean
  /** Historial del flujo anterior (lo pagado, su conteo y promedio; «pendiente» ya no se puede completar). */
  totalPaid: number
  totalPending: number
  payoutCount: number
  averagePayout: number
  recentPayouts: Array<{
    amount: number
    status: string
    paymentMethod: string | null
    staffName: string
    createdAt: Date
    paidAt: Date | null
    periodStart: Date | null
    periodEnd: Date | null
  }>
}

type Money = (value: number) => string

function toNumber(value: unknown): number {
  if (value == null) return 0
  if (typeof value === 'number') return value
  if (typeof value === 'object' && 'toNumber' in value && typeof value.toNumber === 'function') return value.toNumber()
  return Number(value) || 0
}

export async function loadCommissionsSummary(venueId: string): Promise<CommissionsSummary> {
  const stats = await getVenueCommissionStats(venueId)
  return {
    totalPaid: stats.totalPaid,
    staffPayActive: stats.staffPayActive,
    totalCalculated: stats.totalCalculated,
    totalPending: stats.totalPending,
    totalApproved: stats.totalApproved,
    staffWithCommissions: stats.staffWithCommissions,
    averageCommission: stats.averageCommission,
    topEarners: stats.topEarners.map(({ staffName, totalEarned, calculationCount }) => ({ staffName, totalEarned, calculationCount })),
  }
}

/** Sin correos del personal, referencias de pago ni notas: el asistente no los necesita. */
export async function loadCommissionPayoutsSummary(venueId: string, filters: { limit?: number } = {}): Promise<CommissionPayoutsSummary> {
  const limit = Math.min(Math.max(Math.trunc(Number(filters.limit) || 10), 1), 25)
  const [paid, stats, payouts] = await Promise.all([comisionesPagadasEnRecibos(venueId), getPayoutStats(venueId), getPayouts(venueId, {})])
  return {
    paidInStaffPay: toNumber(paid.total),
    staffPayActive: paid.activo,
    totalPaid: stats.totalPaid,
    totalPending: stats.totalPending,
    payoutCount: stats.payoutCount,
    averagePayout: stats.averagePayout,
    recentPayouts: payouts.slice(0, limit).map(payout => ({
      amount: toNumber(payout.amount),
      status: payout.status,
      paymentMethod: payout.paymentMethod || null,
      staffName: payout.staff ? `${payout.staff.firstName || ''} ${payout.staff.lastName || ''}`.trim() || 'Sin nombre' : 'Sin nombre',
      createdAt: payout.createdAt,
      paidAt: payout.paidAt || null,
      periodStart: payout.summary?.periodStart || null,
      periodEnd: payout.summary?.periodEnd || null,
    })),
  }
}

export function commissionsSummaryText(c: CommissionsSummary, top: number, money: Money): string {
  const paid = c.staffPayActive
    ? ` Pagado en los recibos de Pago al personal: ${money(c.totalPaid)}.`
    : ' Lo que pagas de comisiones se registra en el recibo de Pago al personal, que esta sede todavía no usa.'
  const earners = c.topEarners
    .slice(0, top)
    .map(earner => `- ${earner.staffName}: ${money(earner.totalEarned)} en ${earner.calculationCount} cálculos.`)
    .join('\n')
  return `Comisiones calculadas: ${money(c.totalCalculated)}.${paid} ${c.staffWithCommissions} miembros tienen comisiones; promedio ${money(c.averageCommission)}.${earners ? `\nTop comisiones:\n${earners}` : ''}`
}

export function commissionPayoutsText(p: CommissionPayoutsSummary, money: Money): string {
  const head = p.staffPayActive
    ? `Comisiones pagadas en los recibos de Pago al personal: ${money(p.paidInStaffPay)}. El detalle de cada persona está en la pantalla Pago al personal.`
    : 'Desde octubre de 2026 las comisiones se pagan en el recibo de Pago al personal; esta sede todavía no lo usa.'
  if (p.payoutCount === 0) return head
  const count = p.payoutCount === 1 ? 'registró 1 pago' : `registraron ${p.payoutCount} pagos`
  const list = p.recentPayouts
    .filter(payout => payout.status === 'PAID')
    .map(payout => `- ${payout.staffName}: ${money(payout.amount)}, ${payout.paymentMethod || 'sin método'}.`)
    .join('\n')
  return `${head}\nCon el flujo anterior se ${count} por ${money(p.totalPaid)}.${list ? `\nRecientes:\n${list}` : ''}`
}
