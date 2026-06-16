import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { getBankAndCashSummary, getBusinessSummary, getIncomeStatement } from '@/services/dashboard/accounting.dashboard.service'
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
    'accounting_business_summary',
    'Resumen del negocio (Capa A, gerencial — portada de Contabilidad) de un local en un periodo. Reúne: ingreso neto cobrado (base + IVA), facturación del periodo (CFDIs timbrados, % del ingreso ya facturado y cuánto falta por facturar), cómo cobró (efectivo/caja vs banco/electrónico), comisiones de procesamiento, propinas y el estatus de la conciliación bancaria. Responde "¿cómo me fue este mes/periodo?". Pasa venueId y el rango from/to en formato YYYY-MM-DD (zona horaria del local).',
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
      guard.venueFilter(venueId)
      guard.requirePermission('accounting:read', venueId)

      const d = await getBusinessSummary(venueId, { from, to })
      return text({
        venue: d.venueName,
        venueId: d.venueId,
        currency: d.currency,
        period: d.period,
        ingresos: {
          ventasBrutas: pesos(d.revenue.grossSalesCents),
          devoluciones: pesos(d.revenue.refundsCents),
          ingresoNeto: pesos(d.revenue.netRevenueCents),
          baseGravable: pesos(d.revenue.taxableBaseCents),
          ivaTrasladado: pesos(d.revenue.ivaCents),
        },
        facturacion: {
          cfdisTimbrados: d.invoicing.stampedCount,
          nominativos: d.invoicing.nominativeCount,
          globales: d.invoicing.globalCount,
          totalFacturado: pesos(d.invoicing.invoicedApproxCents),
          sinFacturar: pesos(d.invoicing.uninvoicedApproxCents),
          porcentajeFacturado: d.invoicing.invoicedPct,
        },
        cobro: {
          efectivo: pesos(d.collection.cashCents),
          electronico: pesos(d.collection.electronicCents),
          porcentajeEfectivo: d.collection.cashPct,
        },
        comisiones: pesos(d.costs.processingFeesCents),
        ingresoMenosComisiones: pesos(d.result.netAfterFeesCents),
        propinas: pesos(d.tips.totalCents),
        conciliacionBancaria: {
          estadosDeCuenta: d.reconciliation.statements,
          movimientos: d.reconciliation.lineCount,
          conciliados: d.reconciliation.matchedCount,
        },
        metricas: {
          ventas: d.metrics.salesCount,
          devoluciones: d.metrics.refundCount,
          ticketPromedio: pesos(d.metrics.averageTicketCents),
        },
      })
    },
  )

  server.tool(
    'accounting_banks_summary',
    'Bancos y cajas (Capa A) de un local en un periodo: cuánto entró por cada forma de cobro (efectivo, tarjetas, transferencias, monederos, cripto…), separando lo que se quedó en CAJA (efectivo) de lo que va al BANCO (electrónico, neto de comisiones). Responde "¿cuánto tengo en efectivo y cuánto me deposita el banco?". Pasa venueId y el rango from/to en formato YYYY-MM-DD (zona horaria del local).',
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
      guard.venueFilter(venueId)
      guard.requirePermission('accounting:read', venueId)

      const d = await getBankAndCashSummary(venueId, { from, to })
      return text({
        venue: d.venueName,
        venueId: d.venueId,
        currency: d.currency,
        period: d.period,
        cuentas: d.accounts.map(a => ({
          cuenta: a.key,
          tipo: a.kind === 'cash' ? 'caja' : 'banco',
          metodos: a.methods,
          entradas: pesos(a.inflowCents),
          ventas: a.count,
        })),
        totales: {
          efectivoCaja: pesos(d.totals.cashInflowCents),
          electronicoBruto: pesos(d.totals.electronicInflowCents),
          comisiones: pesos(d.totals.feesCents),
          netoAlBanco: pesos(d.totals.netToBankCents),
        },
        conciliacionBancaria: {
          estadosDeCuenta: d.reconciliation.statements,
          movimientos: d.reconciliation.lineCount,
          conciliados: d.reconciliation.matchedCount,
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
