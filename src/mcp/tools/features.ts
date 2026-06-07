import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'

const round2 = (n: number): number => Math.round(n * 100) / 100

export function registerFeatureTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'venue_features',
    'What a venue you can access has turned ON: its active modules (included capabilities like serialized inventory, attendance) and its active paid features/add-ons (with category, monthly price, and whether each is paid, on trial, or suspended for non-payment), plus the recurring monthly cost of those add-ons. Answers "¿qué tengo activado / contratado? ¿qué módulos y features tengo? ¿cuánto pago al mes en add-ons?". Pass venueId. (For the base plan itself use subscription_status.)',
    {
      venueId: z.string().describe('Venue whose modules & features to read (must be in your scope)'),
    },
    async ({ venueId }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      const [modules, features] = await Promise.all([
        prisma.venueModule.findMany({
          where: { ...where, enabled: true },
          select: { enabledAt: true, module: { select: { code: true, name: true } } },
          orderBy: { enabledAt: 'asc' },
        }),
        prisma.venueFeature.findMany({
          where: { ...where, active: true },
          select: {
            monthlyPrice: true,
            startDate: true,
            endDate: true, // not-null = trial period (per schema), null = paid subscription
            suspendedAt: true,
            feature: { select: { code: true, name: true, category: true } },
          },
          orderBy: { startDate: 'asc' },
        }),
      ])

      const featureRows = features.map(f => {
        const state = f.suspendedAt ? 'suspended' : f.endDate ? 'trial' : 'active'
        return {
          code: f.feature.code,
          name: f.feature.name,
          category: f.feature.category,
          monthlyPrice: round2(Number(f.monthlyPrice)),
          state, // 'active' (paid) | 'trial' | 'suspended'
          since: f.startDate.toISOString(),
          ...(f.endDate ? { trialEndsAt: f.endDate.toISOString() } : {}),
          ...(f.suspendedAt ? { suspendedAt: f.suspendedAt.toISOString() } : {}),
        }
      })
      // Only paid (non-trial, non-suspended) add-ons count toward what's actually billed each month.
      const monthlyFeatureCost = round2(featureRows.filter(f => f.state === 'active').reduce((s, f) => s + f.monthlyPrice, 0))

      return text({
        venueId,
        moduleCount: modules.length,
        featureCount: featureRows.length,
        monthlyFeatureCost,
        modules: modules.map(m => ({ code: m.module.code, name: m.module.name, since: m.enabledAt.toISOString() })),
        features: featureRows,
      })
    },
  )
}
