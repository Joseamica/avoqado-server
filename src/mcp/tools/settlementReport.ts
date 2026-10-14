import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { planGateMessage } from '../planGate'
import { construirReporte, ReporteDemasiadoGrandeError, TOPE_CSV } from '@/services/dashboard/settlementReport/settlementReport.service'
import { conTurnoDeReporte } from '@/services/dashboard/settlementReport/settlementReport.export'
import AppError from '@/errors/AppError'

const YMD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export function registerSettlementReportTools(server: McpServer, scope: McpScope): void {
  const guard = createGuard(scope)
  server.tool(
    'settlement_deposits_report',
    "Cuánto dinero de tarjeta te deposita el procesador cada día en un rango («¿qué me cae del 1 al 15 y de qué ventas?»), con consumo, propinas, comisión, IVA de la comisión y depósito neto. Las fechas son ESTIMADAS con las reglas de liquidación de cada cuenta: Avoqado no ve la cuenta bancaria. Pasa venueId, fromDate y toDate (YYYY-MM-DD, máx. 92 días). Opcional: dateBasis ('deposit' por defecto, o 'charge'); depositDate para ver los cobros de ese día; unscheduled=true para los cobros sin fecha calculada; cursor y limit (máx. 100) para paginar ese detalle; terminalIds, cardTypes, brands y operations para filtrar; asOf (fecha-hora ISO) para repetir el corte de una página anterior. Función PRO (ADVANCED_REPORTS).",
    {
      venueId: z.string(),
      fromDate: YMD,
      toDate: YMD,
      dateBasis: z.enum(['deposit', 'charge']).optional(),
      depositDate: YMD.optional(),
      unscheduled: z.boolean().optional(),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      terminalIds: z.array(z.string()).optional(),
      cardTypes: z.array(z.enum(['DEBIT', 'CREDIT', 'AMEX', 'INTERNATIONAL', 'OTHER', 'NONE'])).optional(),
      brands: z
        .array(
          z.enum([
            'VISA',
            'MASTERCARD',
            'AMERICAN_EXPRESS',
            'DISCOVER',
            'DINERS_CLUB',
            'JCB',
            'MAESTRO',
            'UNIONPAY',
            'ELO',
            'HIPERCARD',
            'OTHER',
          ]),
        )
        .optional(),
      operations: z.array(z.enum(['SALE', 'REFUND', 'TIP_REFUND'])).optional(),
      asOf: z.string().datetime().optional(),
    },
    async ({
      venueId,
      fromDate,
      toDate,
      dateBasis,
      depositDate,
      unscheduled,
      cursor,
      limit,
      terminalIds,
      cardTypes,
      brands,
      operations,
      asOf,
    }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('settlements:read', venueId)
      const gate = await planGateMessage(venueId, 'ADVANCED_REPORTS', 'El reporte de depósitos')
      if (gate) return text({ ok: false, planRequired: true, error: gate })
      const ahora = asOf ? new Date(asOf) : new Date()
      let rep
      try {
        rep = await conTurnoDeReporte(() =>
          construirReporte({
            venueId,
            startDate: fromDate,
            endDate: toDate,
            dateBasis: dateBasis ?? 'deposit',
            filtros: { terminalIds, cardTypes, brands, operations },
            tope: TOPE_CSV,
            ahora,
          }),
        )
      } catch (e) {
        if (e instanceof ReporteDemasiadoGrandeError) return text({ ok: false, tooLarge: true, error: e.message })
        if (e instanceof AppError && e.statusCode === 429) return text({ ok: false, busy: true, error: e.message })
        throw e
      }
      const base = { venueId, timezone: rep.timezone, estimated: true, asOf: ahora.toISOString() }
      if (depositDate || unscheduled) {
        const todos = rep.transacciones.filter(t => (unscheduled ? t.fechaDeposito === null : t.fechaDeposito === depositDate))
        let desde = 0
        if (cursor) {
          const i = todos.findIndex(t => t.paymentId === cursor)
          if (i < 0) return text({ ok: false, error: 'El cursor no es válido; vuelve a pedir la primera página.' })
          desde = i + 1
        }
        // folio/autorizacion = referenceNumber/authorizationNumber, sensibles según guard.ts: no salen por MCP (Codex código #2).
        const items = todos.slice(desde, desde + (limit ?? 50)).map(({ folio: _f, autorizacion: _a, ...resto }) => resto)
        const hayMas = desde + items.length < todos.length
        return text({ ...base, total: todos.length, items, nextCursor: hayMas ? items[items.length - 1].paymentId : null })
      }
      return text({ ...base, window: { from: rep.ventanaDesde, to: rep.ventanaHasta }, deposits: rep.depositos, unscheduled: rep.sinFecha })
    },
  )
}
