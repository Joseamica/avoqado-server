import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import { venueStartOfDay, venueEndOfDay } from '@/utils/datetime'
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
 * Carril G (hz:fefa11b6:D4 y D5): las ventas del Resumen de ventas repartidas por canal y por tipo de pedido, y lo cobrado por
 * adelantado que no es venta. Mismo permiso (`reports:read`) y mismo candado de plan (ADVANCED_REPORTS) que la pantalla.
 */
export function registerSalesByChannelTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)
  server.tool(
    'sales_by_channel',
    'Sales of a venue you can access split by channel (where the sale came in: counter, tables, self-service kiosk, customer QR, online store, online payments, payment links, phone, recorded in the dashboard, Rappi, Uber Eats, DiDi Food, other delivery apps) and by order type (in the venue, takeout, delivery, pickup, direct record, amount-only charge), over a date range (default last 7 days, venue-local dates). Same numbers as the dashboard Sales Summary: each table adds up to its headline to the cent (gross sales, discounts, refunds, net sales, tips, Avoqado fees, third-party fees, net collected, transactions, refunds count; orders per row). Money in pesos. Also returns what was collected in advance and is NOT a sale (class packages bought online, reservation deposits net of refunds). Pass venueId; optionally fromDate/toDate (YYYY-MM-DD).',
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
      const start = venueStartOfDay(tz, fromDate ? new Date(`${fromDate}T12:00:00`) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
      const end = venueEndOfDay(tz, toDate ? new Date(`${toDate}T12:00:00`) : undefined)
      const window = { startDate: start.toISOString(), endDate: end.toISOString() }

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
        },
        byChannel: conNombre(report.byChannel, NOMBRE_DEL_CANAL),
        byOrderType: conNombre(report.byOrderType, NOMBRE_DEL_TIPO),
        collectedInAdvanceNotSales: {
          note: 'Not in sales nor in net collected, like gift cards loaded.',
          packagesSoldOnline: { amount: s.packagesSoldOnline ?? 0, count: s.packagesSoldOnlineCount ?? 0 },
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
