import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { moduleService, MODULE_CODES } from '@/services/modules/module.service'
import { getSaldo } from '@/services/dashboard/cash-out/cash-out.ledger.service'
import { listWithdrawals } from '@/services/dashboard/cash-out/cash-out.withdrawal.service'

// Cash Out is on wherever serialized inventory (SIMs) is — it's not a separate module.
const CASH_OUT_OFF =
  'Cash Out no está disponible aquí: requiere el módulo de inventario serializado (SERIALIZED_INVENTORY), que no está activo en este local.'

export function registerCashOutTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'cash_out_saldo',
    "A promoter's available Cash Out commission balance (saldo disponible para retiro) in PESOS, at a venue you can access. Answers '¿cuánto puede retirar este promotor?'. Cash Out is on wherever serialized inventory (SIMs) is. Pass venueId and the promoter's staffId.",
    {
      venueId: z.string().describe('Venue (must be in your scope)'),
      staffId: z.string().describe("The promoter's staff id"),
    },
    async ({ venueId, staffId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('cash-out:read', venueId)
      if (!(await moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY))) {
        return text({ ok: false, moduleRequired: true, error: CASH_OUT_OFF })
      }
      try {
        const saldo = await getSaldo(venueId, staffId)
        return text({ ok: true, venueId, staffId, saldo: saldo.toString() }) // pesos
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

  server.tool(
    'cash_out_withdrawals',
    'Cash Out withdrawals (retiros) at a venue you can access: who requested, amount (PESOS), CLABE, folio and status (REQUESTED -> REPORTED -> PAID). Filter by status (REQUESTED = pending dispersion to pay) or businessDate. Pass venueId.',
    {
      venueId: z.string().describe('Venue (must be in your scope)'),
      status: z.enum(['REQUESTED', 'REPORTED', 'PAID', 'FAILED']).optional().describe('Filter by withdrawal status'),
      businessDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('Filter by day (YYYY-MM-DD)'),
    },
    async ({ venueId, status, businessDate }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('cash-out:read', venueId)
      if (!(await moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY))) {
        return text({ ok: false, moduleRequired: true, error: CASH_OUT_OFF })
      }
      try {
        const items = await listWithdrawals(venueId, { status, businessDate })
        return text({
          ok: true,
          venueId,
          count: items.length,
          withdrawals: items.map(w => ({
            folio: w.folio,
            staffId: w.staffId,
            status: w.status,
            grossAmount: w.grossAmount.toString(),
            netAmount: w.netAmount.toString(),
            clabe: w.clabe,
            businessDate: w.businessDate.toISOString().slice(0, 10),
            requestedAt: w.createdAt,
            reportedAt: w.reportedAt,
            paidAt: w.paidAt,
          })),
        })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )
}
