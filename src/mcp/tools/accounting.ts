import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { getIncomeStatement } from '@/services/dashboard/accounting.dashboard.service'
import { listStatements } from '@/services/dashboard/bankReconciliation.service'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { planGateMessage } from '../planGate'
import { text } from '../respond'

/** Centavos enteros → pesos con 2 decimales (para lectura humana/LLM). */
const pesos = (cents: number): number => Math.round(cents) / 100

export function registerAccountingTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'accounting_income_statement',
    'Estado de resultados (ingresos) de un local en un periodo — Capa A, gerencial (no fiscal). Devuelve: ventas brutas, devoluciones, ingreso neto cobrado, base gravable e IVA trasladado (precios IVA-incluido), propinas (informativas, NO son ingreso) y conteo de ventas. Responde "¿cuánto gané este mes/periodo?". Pasa venueId y el rango from/to en formato YYYY-MM-DD (zona horaria del local).',
    {
      venueId: z.string().describe('Local a reportar (debe estar en tu alcance)'),
      from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('Fecha inicial YYYY-MM-DD (zona del local)'),
      to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('Fecha final YYYY-MM-DD (zona del local)'),
    },
    async ({ venueId, from, to }) => {
      guard.venueFilter(venueId) // lanza ScopeError si el venue está fuera de alcance
      guard.requirePermission('accounting:read', venueId) // mismo gate que el dashboard

      const data = await getIncomeStatement(venueId, { from, to })

      return text({
        venue: data.venueName,
        venueId: data.venueId,
        currency: data.currency,
        timezone: data.timezone,
        period: data.period,
        ivaRateAssumed: data.taxRateAssumed,
        ingresos: {
          ventasBrutas: pesos(data.revenue.grossSalesCents),
          devoluciones: pesos(data.revenue.refundsCents),
          ingresoNeto: pesos(data.revenue.netRevenueCents),
          baseGravable: pesos(data.revenue.taxableBaseCents),
          ivaTrasladado: pesos(data.revenue.ivaCents),
        },
        propinas: pesos(data.tips.totalCents),
        metricas: {
          ventas: data.metrics.salesCount,
          devoluciones: data.metrics.refundCount,
          ticketPromedio: pesos(data.metrics.averageTicketCents),
        },
      })
    },
  )

  server.tool(
    'bank_reconciliation_summary',
    'Conciliación bancaria (PRO): lista los estados de cuenta subidos de un local y cuántos depósitos del banco ya cuadraron contra lo que Avoqado depositó (conciliados/movimientos). Responde "¿ya cuadró mi banco?". Pasa venueId.',
    {
      venueId: z.string().describe('Local a reportar (debe estar en tu alcance)'),
    },
    async ({ venueId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('accounting:read', venueId)
      const gate = await planGateMessage(venueId, 'BANK_RECONCILIATION', 'La conciliación bancaria')
      if (gate) return text({ ok: false, planRequired: true, error: gate })

      const statements = await listStatements(venueId)
      return text({
        ok: true,
        estadosDeCuenta: statements.map(s => ({
          id: s.id,
          archivo: s.fileName,
          periodo: { desde: s.periodStart, hasta: s.periodEnd },
          movimientos: s.lineCount,
          conciliados: s.matchedCount,
          estatus: s.status,
          subido: s.createdAt,
        })),
      })
    },
  )
}
