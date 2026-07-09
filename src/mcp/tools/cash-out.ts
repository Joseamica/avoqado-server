import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { hasPermission } from '@/services/access/access.service'
import type { McpScope } from '../scope'
import { createGuard, ScopeError } from '../guard'
import { text } from '../respond'
import { moduleService, MODULE_CODES } from '@/services/modules/module.service'
import { getSaldo } from '@/services/dashboard/cash-out/cash-out.ledger.service'
import { listWithdrawals } from '@/services/dashboard/cash-out/cash-out.withdrawal.service'
import {
  listCommissionRatesForOrg,
  listActiveDaysForOrg,
  resolveRatesForVenue,
  resolveActiveDaysForVenue,
} from '@/services/dashboard/cash-out/cash-out.config.service'
import { listWithdrawalsForOrg, getSaldosForOrg } from '@/services/dashboard/cash-out/cash-out.org.service'

// Cash Out is on wherever serialized inventory (SIMs) is — it's not a separate module.
const CASH_OUT_OFF =
  'Cash Out no está disponible aquí: requiere el módulo de inventario serializado (SERIALIZED_INVENTORY), que no está activo en este local.'

export function registerCashOutTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  /** Org-level gate: caller must hold `cash-out:read` in SOME venue of the active org. Mirrors org_confirmed_sales_report's requireReviewAccess. */
  function requireOrgReadAccess(): string {
    if (!scope.activeOrg) {
      throw new ScopeError('No hay una organización activa en esta conexión — reconéctate eligiendo una organización.')
    }
    for (const access of scope.perVenueAccess.values()) {
      if (access.organizationId === scope.activeOrg && hasPermission(access, 'cash-out:read')) return scope.activeOrg
    }
    throw new ScopeError('Missing permission cash-out:read in this organization')
  }

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

  server.tool(
    'cash_out_org_commission_rates',
    'Tabla de comisiones escalonadas de Cash Out (Línea Nueva / Portabilidad × rangos de acumulado), en PESOS. Sin venueId: la tabla org-wide — la configuración uniforme que aplica a TODOS los venues de tu organización activa que no tengan su propia tabla (venue-level la sobreescribe). Con venueId: la tabla EFECTIVA para ESE venue (su propia tabla si tiene una, si no la de la organización) — usa esto para responder correctamente cuánto se le paga a un promotor de un venue específico. Responde "¿cuánto se paga por cada SIM vendida según el acumulado del mes?".',
    {
      venueId: z
        .string()
        .optional()
        .describe(
          'Pass a venueId to get the EFFECTIVE table for ONE store (its own override if set, else the org default). Omit for the org-wide table.',
        ),
    },
    async ({ venueId }) => {
      try {
        if (venueId) {
          guard.venueFilter(venueId)
          guard.requirePermission('cash-out:read', venueId)
          if (!(await moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY))) {
            return text({ ok: false, moduleRequired: true, error: CASH_OUT_OFF })
          }
          const rates = await resolveRatesForVenue(venueId)
          return text({
            ok: true,
            scope: 'venue',
            venueId,
            count: rates.length,
            rates: rates.map(r => ({
              saleType: r.saleType,
              minCount: r.minCount,
              maxCount: r.maxCount,
              amount: r.amount.toString(), // pesos
            })),
          })
        }
        const orgId = requireOrgReadAccess()
        const rates = await listCommissionRatesForOrg(orgId)
        return text({
          ok: true,
          scope: 'org',
          orgId,
          count: rates.length,
          rates: rates.map(r => ({
            saleType: r.saleType,
            minCount: r.minCount,
            maxCount: r.maxCount,
            amount: r.amount.toString(), // pesos
          })),
        })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

  server.tool(
    'cash_out_org_active_days',
    'Días activos de Cash Out (calendario ADMIN). Sin venueId: el calendario org-wide, aplican a todos los venues de tu organización activa que no tengan su propio calendario. Con venueId: el calendario EFECTIVO para ESE venue (su propio calendario si tiene uno, si no el de la organización) — usa esto para responder correctamente qué días puede retirar un promotor de un venue específico. Responde "¿qué días se puede retirar Cash Out?".',
    {
      venueId: z
        .string()
        .optional()
        .describe(
          'Pass a venueId to get the EFFECTIVE calendar for ONE store (its own override if set, else the org default). Omit for the org-wide calendar.',
        ),
    },
    async ({ venueId }) => {
      try {
        if (venueId) {
          guard.venueFilter(venueId)
          guard.requirePermission('cash-out:read', venueId)
          if (!(await moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY))) {
            return text({ ok: false, moduleRequired: true, error: CASH_OUT_OFF })
          }
          const days = await resolveActiveDaysForVenue(venueId)
          return text({ ok: true, scope: 'venue', venueId, count: days.length, days })
        }
        const orgId = requireOrgReadAccess()
        const days = await listActiveDaysForOrg(orgId)
        return text({ ok: true, scope: 'org', orgId, count: days.length, days })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

  server.tool(
    'cash_out_org_withdrawals',
    'Retiros (withdrawals) de Cash Out agregados org-wide: unión de los retiros de TODOS los venues de tu organización activa, cada uno con el nombre del venue (venueName). Quién solicitó, monto (PESOS), CLABE, folio y status (REQUESTED -> REPORTED -> PAID). Filtra por status (REQUESTED = pendiente de dispersión) o businessDate. No requiere venueId — usa la organización activa de esta conexión.',
    {
      status: z.enum(['REQUESTED', 'REPORTED', 'PAID', 'FAILED']).optional().describe('Filter by withdrawal status'),
      businessDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('Filter by day (YYYY-MM-DD)'),
    },
    async ({ status, businessDate }) => {
      try {
        const orgId = requireOrgReadAccess()
        const items = await listWithdrawalsForOrg(orgId, { status, businessDate })
        return text({
          ok: true,
          orgId,
          count: items.length,
          withdrawals: items.map(w => ({
            folio: w.folio,
            venueId: w.venueId,
            venueName: w.venueName,
            staffId: w.staffId,
            promoterName: w.promoterName,
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

  server.tool(
    'cash_out_org_saldos',
    'Saldo de Cash Out DISPONIBLE por promotor, agregado en TODA tu organización activa (PESOS). Cada fila: venue, promotor y su saldo retirable. Ordenado de mayor a menor. Responde "¿cuánto le debo de comisión a todos los promotores? ¿quién trae más saldo?". Refresca el saldo antes de leer (respeta días activos y excluye ventas MANUAL_ENTRY). No requiere venueId — usa la organización activa de esta conexión.',
    {},
    async () => {
      try {
        const orgId = requireOrgReadAccess()
        const saldos = await getSaldosForOrg(orgId)
        return text({
          ok: true,
          orgId,
          count: saldos.length,
          totalSaldo: saldos.reduce((a, s) => a + Number(s.saldo), 0).toFixed(2),
          saldos,
        })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )
}
