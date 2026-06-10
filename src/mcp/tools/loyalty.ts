import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'
import { adjustPoints, updateLoyaltyConfig } from '@/services/dashboard/loyalty.dashboard.service'

export function registerLoyaltyTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'loyalty_status',
    'The loyalty / rewards program settings for a venue you can access: whether it is active, points earned per dollar spent and per visit, the redemption rate (money value of one point), the minimum points needed to redeem, and after how many days points expire. Answers "¿cómo funciona mi programa de recompensas? ¿cuántos puntos doy por compra?". Pass venueId. (A specific customer\'s point balance is in find_customer.)',
    {
      venueId: z.string().describe('Venue whose loyalty program to read (must be in your scope)'),
    },
    async ({ venueId }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      // Read the config directly (NOT the get-or-create service) so this read never writes a default row.
      const cfg = await prisma.loyaltyConfig.findFirst({
        where,
        select: {
          active: true,
          pointsPerDollar: true,
          pointsPerVisit: true,
          redemptionRate: true,
          minPointsRedeem: true,
          pointsExpireDays: true,
        },
      })
      return text({
        venueId,
        configured: !!cfg,
        program: cfg
          ? {
              active: cfg.active,
              pointsPerDollar: Number(cfg.pointsPerDollar),
              pointsPerVisit: cfg.pointsPerVisit,
              redemptionRate: Number(cfg.redemptionRate), // money value of 1 point
              minPointsToRedeem: cfg.minPointsRedeem,
              pointsExpireDays: cfg.pointsExpireDays, // null = never expire
            }
          : null,
      })
    },
  )

  server.tool(
    'adjust_loyalty_points',
    '🔴 CRITICAL (moves customer value). Manually add or remove loyalty points on a customer of a venue you can access — e.g. a goodwill bonus or correcting an error. Find the customer by name/email/phone; points is the CHANGE (positive adds, negative removes; balance can never go below 0); a reason is required. By DEFAULT this only PREVIEWS (current balance → new balance); to actually apply it call again with confirm:true. This WRITES — requires loyalty:adjust.',
    {
      venueId: z.string().describe('Venue that owns the customer (must be in your scope)'),
      search: z.string().min(1).describe('Customer name, email or phone (partial, case-insensitive)'),
      points: z.number().int().describe('Point CHANGE: positive adds (e.g. 100), negative removes (e.g. -50). NOT the new total.'),
      reason: z.string().min(1).describe('Why — required for the audit trail (e.g. "compensación por demora")'),
      confirm: z.boolean().optional().describe('Must be true to actually apply; without it you get a preview'),
    },
    async ({ venueId, search, points, reason, confirm }) => {
      const base = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('loyalty:adjust', venueId) // write gate (per-venue role)
      if (points === 0) return text({ ok: false, error: 'points no puede ser 0.' })

      const matches = await prisma.customer.findMany({
        where: {
          ...base,
          OR: [
            { firstName: { contains: search, mode: 'insensitive' as const } },
            { lastName: { contains: search, mode: 'insensitive' as const } },
            { email: { contains: search, mode: 'insensitive' as const } },
            { phone: { contains: search } },
          ],
        },
        select: { id: true, firstName: true, lastName: true, loyaltyPoints: true },
        orderBy: { totalSpent: 'desc' },
        take: 5,
      })
      if (matches.length === 0) {
        return text({ ok: false, error: `No encontré ningún cliente que coincida con "${search}" en este local.` })
      }
      if (matches.length > 1) {
        return text({
          ok: false,
          ambiguous: true,
          error: `"${search}" coincide con varios clientes — sé más específico.`,
          matches: matches.map(m => `${m.firstName ?? ''} ${m.lastName ?? ''}`.trim() || '(sin nombre)'),
        })
      }

      const c = matches[0]
      const name = `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || '(sin nombre)'
      const newBalance = c.loyaltyPoints + points
      if (newBalance < 0) {
        return text({ ok: false, error: `No se puede: dejaría el balance en ${newBalance} (tiene ${c.loyaltyPoints} puntos).` })
      }

      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: { customer: name, currentPoints: c.loyaltyPoints, change: points, newBalance, reason },
          message: `Esto ${points > 0 ? 'AGREGARÁ' : 'QUITARÁ'} ${Math.abs(points)} puntos a ${name} (${c.loyaltyPoints} → ${newBalance}). Vuelve a llamar con confirm:true para aplicar.`,
        })
      }

      try {
        const result = await adjustPoints(venueId, c.id, points, reason, scope.staffId) // service re-validates + self-audits
        await auditMcpWrite(scope, {
          action: 'LOYALTY_POINTS_ADJUSTED',
          entity: 'Customer',
          entityId: c.id,
          venueId,
          data: { points, reason, newBalance: result.newBalance },
        })
        return text({ ok: true, customer: name, change: points, newBalance: result.newBalance })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

  server.tool(
    'configure_loyalty',
    'Configure (or activate/deactivate) the loyalty / rewards PROGRAM of a venue you can access: points earned per dollar spent, points per visit, the redemption rate (money value of one point, e.g. 0.05 = 5 centavos per point), the minimum points to redeem, and after how many days points expire (null/omit = never). Only the fields you pass are changed. This WRITES program settings (does NOT touch any customer\'s points — use adjust_loyalty_points for that); requires loyalty:update.',
    {
      venueId: z.string().describe('Venue whose program to configure (must be in your scope)'),
      active: z.boolean().optional().describe('Turn the program on/off'),
      pointsPerDollar: z.number().min(0).optional().describe('Points earned per $1 spent'),
      pointsPerVisit: z.number().int().min(0).optional().describe('Points earned per visit'),
      redemptionRate: z.number().min(0).optional().describe('Money value of 1 point (e.g. 0.05)'),
      minPointsToRedeem: z.number().int().min(0).optional().describe('Minimum points required to redeem'),
      pointsExpireDays: z.number().int().positive().nullable().optional().describe('Days until points expire; null = never'),
    },
    async ({ venueId, active, pointsPerDollar, pointsPerVisit, redemptionRate, minPointsToRedeem, pointsExpireDays }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('loyalty:update', venueId) // write gate (per-venue role)
      const data = {
        ...(active !== undefined ? { active } : {}),
        ...(pointsPerDollar !== undefined ? { pointsPerDollar } : {}),
        ...(pointsPerVisit !== undefined ? { pointsPerVisit } : {}),
        ...(redemptionRate !== undefined ? { redemptionRate } : {}),
        ...(minPointsToRedeem !== undefined ? { minPointsRedeem: minPointsToRedeem } : {}),
        ...(pointsExpireDays !== undefined ? { pointsExpireDays } : {}),
      }
      if (Object.keys(data).length === 0) return text({ ok: false, error: 'No pasaste ningún campo para configurar.' })

      try {
        const cfg = await updateLoyaltyConfig(venueId, data) // service validates non-negative etc.
        await auditMcpWrite(scope, {
          action: 'LOYALTY_CONFIG_UPDATED',
          entity: 'LoyaltyConfig',
          entityId: (cfg as { id?: string })?.id ?? venueId,
          venueId,
          data,
        })
        return text({
          ok: true,
          program: {
            active: (cfg as { active: boolean }).active,
            pointsPerDollar: Number((cfg as { pointsPerDollar: unknown }).pointsPerDollar),
            pointsPerVisit: (cfg as { pointsPerVisit: number }).pointsPerVisit,
            redemptionRate: Number((cfg as { redemptionRate: unknown }).redemptionRate),
            minPointsToRedeem: (cfg as { minPointsRedeem: number }).minPointsRedeem,
            pointsExpireDays: (cfg as { pointsExpireDays: number | null }).pointsExpireDays,
          },
        })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )
}
