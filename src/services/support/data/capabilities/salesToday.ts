import { getSalesSummary, type SalesSummaryMetrics } from '@/services/dashboard/sales-summary.dashboard.service'
import { sumsLegacyQrPayments } from '@/services/legacy/qrPayments.legacy.service'
import type { DataCapability } from '../catalog'
import { template } from '../check'
import { wholeDayBounds } from '../params'

/**
 * C1 · «Ventas de hoy»: las seis cifras de Reportes › Resumen de ventas del día calendario entero de la sucursal, las mismas que el
 * panel. Permiso de la ruta del panel (`reports:read`), sin puesto ni candado de plan: el Gratis incluye el resumen de hoy.
 */

/** Sin filtro el resumen no trae nulls; si llegara uno, la plantilla lanza y la respuesta sale CHECK_FAILED, nunca «$0.00». */
function present(value: number | null): number {
  if (value === null) throw new Error('Sales summary field missing')
  return value
}

export const salesToday: DataCapability<Record<string, never>, SalesSummaryMetrics> = {
  key: 'sales_today',
  label: 'ventas de hoy',
  object: 'las ventas de hoy',
  aiHint: 'Cuánto vendió hoy la sucursal: ventas brutas, descuentos, devoluciones, ventas netas, propinas y transacciones. Sólo de hoy.',
  permissions: ['reports:read'],
  // La sucursal del puente suma cobros del sistema anterior: por aquí no se da un total que no es el completo.
  notOffered: scope => (sumsLegacyQrPayments(scope.venueId) ? 'SALES_LEGACY_QR' : null),
  params: request =>
    request.day === null || request.day === 'today' ? { ok: true, value: {} } : { ok: false, refusal: 'SALES_TODAY_ONLY' },
  read: async scope => {
    const { from, to } = wholeDayBounds('today', scope)
    const report = await getSalesSummary(scope.venueId, {
      startDate: from.toISOString(),
      endDate: to.toISOString(),
      groupBy: 'none',
      reportType: 'summary',
      timezone: scope.timezone,
      skipStaffCommissions: true,
    })
    // T-B28: un total que el propio resumen marca como posiblemente incompleto no se dice como cifra (QUERY_FAILED).
    if (report.legacyUnavailable) throw new Error('Sales summary marked incomplete')
    return report.summary
  },
  render: (scope, _params, summary) => {
    const t = template(scope.timezone)
    const count = summary.transactionCount
    const lines = [
      `Ventas de hoy, ${t.shortDay(scope.now)}, en ${t.text(scope.venueName)} (corte ${t.time(scope.now)}):`,
      `Ventas brutas ${t.money(present(summary.grossSales))} · Descuentos ${t.money(-present(summary.discounts))} · Devoluciones ${t.money(-summary.refunds)}`,
      `*Ventas netas ${t.money(present(summary.netSales))}*`,
      `Propinas (aparte) ${t.money(summary.tips)} · ${t.count(count)} ${count === 1 ? 'transacción' : 'transacciones'}`,
      'Es lo mismo que Reportes › Resumen de ventas.',
    ]
    return t.done(lines.join('\n'))
  },
}
