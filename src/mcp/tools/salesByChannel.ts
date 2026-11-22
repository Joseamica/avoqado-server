import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { DateTime } from 'luxon'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { planGateMessage } from '../planGate'
import { getSalesSummary } from '@/services/dashboard/sales-summary.dashboard.service'
import type { SalesBreakdownRow } from '@/services/dashboard/salesSummaryCanales'
import { AVISO_PUENTE_QR_CAIDO } from '@/services/legacy/qrPayments.legacy.service'

/** El nombre que ve el dueño en el panel (Reportes › Resumen de ventas › Ventas por canal). */
export const NOMBRE_DEL_CANAL: Record<string, string> = {
  COUNTER: 'Mostrador',
  TABLES: 'Mesas',
  KIOSK: 'Autoservicio',
  QR: 'QR del cliente',
  ONLINE_STORE: 'Tienda en línea',
  WEB_CHECKOUT: 'Pagos en línea',
  PAYMENT_LINK: 'Ligas de pago',
  PHONE: 'Teléfono',
  DASHBOARD: 'Registradas en el panel',
  RAPPI: 'Rappi',
  UBER_EATS: 'Uber Eats',
  DIDI_FOOD: 'DiDi Food',
  OTHER_DELIVERY: 'Otras apps de delivery',
  QR_LEGACY: 'QR (sistema anterior)',
  OTHER: 'Otro canal',
}

export const NOMBRE_DEL_TIPO: Record<string, string> = {
  DINE_IN: 'En el local',
  TAKEOUT: 'Para llevar',
  DELIVERY: 'A domicilio',
  PICKUP: 'Para recoger',
  MANUAL_ENTRY: 'Registro directo',
  QUICK_PAYMENT: 'Cobro de un monto',
  QR_LEGACY: 'QR (sistema anterior), sin tipo',
  OTHER: 'Otro tipo',
}

const conNombre = (filas: SalesBreakdownRow[] | undefined, nombres: Record<string, string>) =>
  (filas ?? []).map(f => ({ ...f, label: nombres[f.key] ?? f.key }))

/**
 * El rango en días del negocio, igual que el panel: sin fechas, hoy y los seis días anteriores (`getLast7Days` del DASHBOARD; Codex r2
 * #7). Una fecha que no existe (2026-02-30) o al revés se rechaza en vez de moverse sola.
 */
export function rangoDelNegocio(
  tz: string,
  fromDate?: string,
  toDate?: string,
): { startDate: string; endDate: string } | { error: string } {
  const dia = (s: string) => DateTime.fromFormat(s, 'yyyy-MM-dd', { zone: tz })
  const hoy = DateTime.now().setZone(tz)
  const desde = fromDate ? dia(fromDate) : hoy.minus({ days: 6 })
  const hasta = toDate ? dia(toDate) : hoy
  if (!desde.isValid || !hasta.isValid) return { error: 'Las fechas van como AAAA-MM-DD y tienen que existir (por ejemplo 2026-11-01).' }
  if (desde.startOf('day') > hasta.startOf('day')) return { error: 'La fecha de inicio va antes que la de fin.' }
  return { startDate: desde.startOf('day').toUTC().toISO()!, endDate: hasta.endOf('day').toUTC().toISO()! }
}

/**
 * Carril G (hz:fefa11b6:D4 y D5): las ventas del Resumen de ventas repartidas por canal y por tipo de pedido, y lo cobrado por
 * adelantado que no es venta. Mismo permiso (`reports:read`) y mismo candado de plan (ADVANCED_REPORTS) que la pantalla.
 */
export function registerSalesByChannelTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)
  server.tool(
    'sales_by_channel',
    'Sales of a venue you can access split by channel (where the sale came in: counter, tables, self-service kiosk, customer QR, online store, online payments, payment links, phone, recorded in the dashboard, Rappi, Uber Eats, DiDi Food, other delivery apps) and by order type (in the venue, takeout, delivery, pickup, direct record, amount-only charge), over a date range (venue-local days; default today and the 6 previous days, like the dashboard). Same numbers as the dashboard Sales Summary: each table adds up to its headline to the cent (gross sales, discounts, refunds, net sales, tips, Avoqado fees, third-party fees, net collected, transactions, refunds count; orders per row). Money in pesos. Also returns what was collected in advance and is NOT a sale (class packages bought online, in pesos and any other currency listed apart; reservation deposits net of refunds). Pass venueId; optionally fromDate/toDate (YYYY-MM-DD).',
    {
      venueId: z.string().describe('Venue to analyze (must be in your scope)'),
      fromDate: z.string().optional().describe('Start date YYYY-MM-DD (default: 7 days ago)'),
      toDate: z.string().optional().describe('End date YYYY-MM-DD (default: today)'),
    },
    async ({ venueId, fromDate, toDate }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('reports:read', venueId) // the same as the dashboard Sales Summary
      const gate = await planGateMessage(venueId, 'ADVANCED_REPORTS', 'Las ventas por canal')
      if (gate) return text({ ok: false, planRequired: true, error: gate })

      const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
      const tz = venue?.timezone || 'America/Mexico_City'
      const window = rangoDelNegocio(tz, fromDate, toDate)
      if ('error' in window) return text({ ok: false, error: window.error })

      const report = await getSalesSummary(venueId, {
        ...window,
        reportType: 'summary',
        timezone: tz,
        includeChannelBreakdown: true,
        includePrepaid: true,
        skipStaffCommissions: true,
      })
      const s = report.summary
      return text({
        venueId,
        window,
        timezone: tz,
        // D15: con el puente de cobros QR viejos caído (sólo Mindform), lo de esa fuente puede estar incompleto.
        ...(report.legacyUnavailable ? { legacyUnavailable: true as const, aviso: AVISO_PUENTE_QR_CAIDO } : {}),
        // Las tablas se leyeron un instante después de la cabecera y alguna cifra cambió (entró una venta): hay que volver a preguntar.
        ...(report.channelBreakdownOutOfSync
          ? {
              outOfSync: true as const,
              avisoDeLectura: 'A sale came in while reading: the tables may not add up to the headline. Ask again.',
            }
          : {}),
        headline: {
          grossSales: s.grossSales,
          discounts: s.discounts,
          refunds: s.refunds,
          netSales: s.netSales,
          tips: s.tips,
          platformFees: s.platformFees,
          tenderCommissions: s.tenderCommissions ?? 0,
          totalCollected: s.totalCollected,
          transactionCount: s.transactionCount,
          refundCount: s.refundCount ?? 0,
        },
        byChannel: conNombre(report.byChannel, NOMBRE_DEL_CANAL),
        byOrderType: conNombre(report.byOrderType, NOMBRE_DEL_TIPO),
        collectedInAdvanceNotSales: {
          note: 'Not in sales nor in net collected, like gift cards loaded. Dated when Avoqado got the payment confirmation (usually seconds after the charge).',
          packagesSoldOnline: { amount: s.packagesSoldOnline ?? 0, count: s.packagesSoldOnlineCount ?? 0, currency: 'MXN' },
          // Paquetes cobrados en otra moneda: aparte, nunca sumados a los pesos.
          ...(s.packagesSoldOnlineOtherCurrencies?.length
            ? { packagesSoldOnlineOtherCurrencies: s.packagesSoldOnlineOtherCurrencies }
            : {}),
          reservationDeposits: {
            amount: s.reservationDeposits ?? 0,
            count: s.reservationDepositsCount ?? 0,
            refunded: s.reservationDepositsRefunded ?? 0,
          },
        },
      })
    },
  )
}
