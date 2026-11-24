import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { DateTime } from 'luxon'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { rangoDelNegocio } from './salesByChannel'
import { CIFRAS_QUE_SE_COMPARAN, MENSAJES_DE_COMPARAR, leerConComparacion, rangoComparado } from '@/services/dashboard/salesSummaryComparar'
import { comparacionBloqueadaPorPlan } from '@/services/dashboard/salesSummaryPlanRange'
import { AVISO_PUENTE_QR_CAIDO } from '@/services/legacy/qrPayments.legacy.service'
import { zonaDelCalculo } from '@/utils/sanitizeTimezone'

/** El nombre de cada cifra como la ve el dueño en el panel (Reportes › Resumen de ventas). */
export const NOMBRE_DE_LA_CIFRA: Record<(typeof CIFRAS_QUE_SE_COMPARAN)[number], string> = {
  grossSales: 'Ventas brutas',
  items: 'Artículos',
  serviceCosts: 'Cargos por servicio',
  chargedAmount: 'Cobrado',
  refunds: 'Devoluciones',
  refundCount: 'Devoluciones (cuántas)',
  discounts: 'Descuentos',
  netSales: 'Ventas netas',
  taxes: 'Impuestos incluidos',
  tips: 'Propinas',
  platformFees: 'Comisiones de plataforma',
  tenderCommissions: 'Comisiones de terceros',
  totalCollected: 'Neto cobrado',
  paidWithGiftCardBalance: 'Pagado con saldo',
  staffCommissions: 'Comisiones a empleados',
  netProfit: 'Ganancia neta',
  unpaidSales: 'Sin cobrar',
  unpaidOrders: 'Sin cobrar (cuentas)',
  giftCardLoads: 'Tarjetas de regalo cargadas',
  giftCardLoadsCount: 'Tarjetas de regalo cargadas (cuántas)',
  packagesSoldOnline: 'Paquetes vendidos en línea',
  packagesSoldOnlineCount: 'Paquetes vendidos en línea (cuántos)',
  reservationDeposits: 'Depósitos de reservas',
  reservationDepositsCount: 'Depósitos de reservas (cuántos)',
  transactionCount: 'Cobros',
}

export const AVISO_SIN_QR_ANTERIOR = 'El periodo comparado no incluye los cobros del QR anterior; por eso no se calcula el cambio.'

/**
 * Carril F2 (hz:fefa11b6:D7): el Resumen de ventas comparado con otro periodo, con las mismas cifras y reglas que el panel (Reportes ›
 * Resumen de ventas › «Comparar con»). Pro, `reports:read`. Catálogo libre (no está en el certificado: `sales_comparison` es otra cosa).
 */
export function registerCompareSalesPeriodsTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)
  server.tool(
    'compare_sales_periods',
    'Compare the Sales Summary of a venue you can access against another period, with the same numbers as the dashboard (Reports › Sales Summary › "Compare with"): gross sales, discounts, refunds, net sales, taxes, tips, Avoqado fees, third-party fees, net collected, staff commissions, net profit, unpaid, gift cards loaded, packages and deposits collected in advance, and the number of charges — each with the other period, the difference in pesos and the % change ("isNew" when the other period was $0; no % when it was $0 or negative). compareTo: "previous_period" (the same length right before; a whole month against the whole previous month) or "previous_year" (52 weeks before for a day or whole weeks, so the weekdays match; otherwise the same dates last year). A period still in progress (today, this week) is compared up to the same time. Dates are venue-local YYYY-MM-DD; default today and the 6 previous days. Up to one year; a period that has not started cannot be compared. Requires the Pro plan. Money in pesos.',
    {
      venueId: z.string().describe('Venue to analyze (must be in your scope)'),
      fromDate: z.string().optional().describe('Start date YYYY-MM-DD, venue-local (default: 6 days before toDate)'),
      toDate: z.string().optional().describe('End date YYYY-MM-DD (default: today)'),
      compareTo: z.enum(['previous_period', 'previous_year']).default('previous_period').describe('What to compare against'),
    },
    async ({ venueId, fromDate, toDate, compareTo }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('reports:read', venueId) // the same as the dashboard Sales Summary
      if (await comparacionBloqueadaPorPlan(venueId)) {
        return text({ ok: false, planRequired: true, error: 'Comparar con otro periodo requiere el plan Pro.' })
      }

      const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
      const tz = zonaDelCalculo(venue?.timezone)
      // Un solo reloj: «hoy» por default y el corte «hasta la misma hora» salen del mismo instante.
      const T = new Date()
      const window = rangoDelNegocio(tz, fromDate, toDate ?? DateTime.fromJSDate(T).setZone(tz).toFormat('yyyy-MM-dd'))
      if ('error' in window) return text({ ok: false, error: window.error })
      // Lo que no se puede comparar se dice antes de leer: la tool no necesita el reporte de siempre (el GET sí).
      const rango = rangoComparado(window.startDate, window.endDate, compareTo ?? 'previous_period', tz, T)
      if (rango.status !== 'ok') return text({ ok: false, error: MENSAJES_DE_COMPARAR[rango.status] })

      const r = await leerConComparacion(
        venueId,
        { ...window, groupBy: 'none', reportType: 'summary', timezone: tz, includePrepaid: true },
        compareTo ?? 'previous_period',
        T,
      )
      const c = r.comparison
      if (c.status === 'plan') return text({ ok: false, planRequired: true, error: c.message })
      if (c.status !== 'ok') return text({ ok: false, error: c.message })

      return text({
        venueId,
        timezone: tz,
        compareTo: c.compareTo,
        current: c.baseRange,
        compared: c.dateRange,
        untilSameTime: c.untilSameTime,
        matchedWeekday: c.matchedWeekday,
        ...(c.excludesLegacyQr ? { excludesLegacyQr: true as const, avisoQrAnterior: AVISO_SIN_QR_ANTERIOR } : {}),
        // El lado actual no pudo leer el puente del QR anterior: su total puede estar incompleto.
        ...(r.legacyUnavailable ? { legacyUnavailable: true as const, aviso: AVISO_PUENTE_QR_CAIDO } : {}),
        lines: CIFRAS_QUE_SE_COMPARAN.map(key => ({
          key,
          label: NOMBRE_DE_LA_CIFRA[key],
          current: r.summary[key] ?? null,
          compared: c.summary?.[key] ?? null,
          change: c.changes?.[key] ?? null,
        })),
        // En otra moneda no se suman a los pesos ni se comparan: la lista de cada lado.
        packagesSoldOnlineOtherCurrencies: {
          current: r.summary.packagesSoldOnlineOtherCurrencies ?? [],
          compared: c.summary?.packagesSoldOnlineOtherCurrencies ?? [],
        },
      })
    },
  )
}
