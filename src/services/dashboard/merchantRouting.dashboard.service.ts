/**
 * CRUD de reglas MERCHANT_ROUTING_RULES para el dashboard (admin del negocio).
 *
 * - El universo de merchants configurables es EXACTAMENTE el que la TPV ve
 *   (getVenueMerchantAccounts) — nunca se expone `credentials` al dashboard.
 * - Máx. 1 regla por (venue, merchant); condiciones validadas por zod en la ruta.
 * - Toda mutación escribe ActivityLog (con `previous` para reversibilidad).
 * - El preview delega en el MISMO motor que usa la TPV (simulador honesto).
 */
import { Prisma } from '@prisma/client'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import type { MerchantRoutingConditionsInput } from '../../schemas/dashboard/merchantRouting.schema'
import {
  getMerchantEligibility,
  getVisibleMerchants,
  type MerchantEligibilityInput,
  type MerchantEligibilityResult,
} from '../tpv/merchantRouting.service'
import { logAction } from './activity-log.service'

export interface VenueRoutingRuleView {
  merchantAccountId: string
  displayName: string
  providerCode: string
  displayOrder: number
  rule: { active: boolean; conditions: Prisma.JsonValue; updatedAt: Date } | null
}

export async function listVenueRoutingRules(venueId: string): Promise<{ merchants: VenueRoutingRuleView[] }> {
  // Valida venue (NotFound) y trae el MISMO universo que la TPV (sin credenciales).
  const accounts = await getVisibleMerchants(venueId)
  const rules = await prisma.merchantRoutingRule.findMany({ where: { venueId } })
  const ruleByMerchant = new Map(rules.map(r => [r.merchantAccountId, r]))

  return {
    merchants: accounts.map(a => {
      const rule = ruleByMerchant.get(a.id)
      return {
        merchantAccountId: a.id,
        displayName: a.displayName,
        providerCode: a.providerCode,
        displayOrder: a.displayOrder,
        rule: rule ? { active: rule.active, conditions: rule.conditions, updatedAt: rule.updatedAt } : null,
      }
    }),
  }
}

export async function upsertVenueRoutingRule(
  venueId: string,
  input: { merchantAccountId: string; active: boolean; conditions: MerchantRoutingConditionsInput },
  performedBy?: string,
) {
  const accounts = await getVisibleMerchants(venueId)
  const validIds = new Set<string>(accounts.map(a => a.id))
  if (!validIds.has(input.merchantAccountId)) {
    throw new BadRequestError('El merchant no pertenece a la configuración de pagos de este venue')
  }

  const where = { venueId_merchantAccountId: { venueId, merchantAccountId: input.merchantAccountId } }
  const previous = await prisma.merchantRoutingRule.findUnique({ where })

  const rule = await prisma.merchantRoutingRule.upsert({
    where,
    create: {
      venueId,
      merchantAccountId: input.merchantAccountId,
      active: input.active,
      conditions: input.conditions as Prisma.InputJsonValue,
      createdById: performedBy ?? null,
    },
    update: {
      active: input.active,
      conditions: input.conditions as Prisma.InputJsonValue,
    },
  })

  // Fire-and-forget: la auditoría nunca rompe la mutación (regla del repo).
  void logAction({
    staffId: performedBy ?? null,
    venueId,
    action: previous ? 'MERCHANT_ROUTING_RULE_UPDATED' : 'MERCHANT_ROUTING_RULE_CREATED',
    entity: 'MerchantRoutingRule',
    entityId: rule.id,
    data: {
      merchantAccountId: input.merchantAccountId,
      active: input.active,
      conditions: input.conditions,
      previous: previous ? { active: previous.active, conditions: previous.conditions } : null,
    } as Prisma.InputJsonValue,
  })

  return {
    id: rule.id,
    merchantAccountId: rule.merchantAccountId,
    active: rule.active,
    conditions: rule.conditions,
    updatedAt: rule.updatedAt,
  }
}

export async function deleteVenueRoutingRule(venueId: string, merchantAccountId: string, performedBy?: string) {
  const where = { venueId_merchantAccountId: { venueId, merchantAccountId } }
  const previous = await prisma.merchantRoutingRule.findUnique({ where })
  if (!previous) throw new NotFoundError('No existe una regla para este merchant en este venue')

  await prisma.merchantRoutingRule.delete({ where: { id: previous.id } })

  void logAction({
    staffId: performedBy ?? null,
    venueId,
    action: 'MERCHANT_ROUTING_RULE_DELETED',
    entity: 'MerchantRoutingRule',
    entityId: previous.id,
    data: {
      merchantAccountId,
      previous: { active: previous.active, conditions: previous.conditions },
    } as Prisma.InputJsonValue,
  })

  return { deleted: true }
}

/** Simulador del dashboard — mismo motor y misma respuesta que la TPV. */
export async function previewVenueEligibility(
  venueId: string,
  input: MerchantEligibilityInput,
  actor?: { staffId?: string; role?: string },
): Promise<MerchantEligibilityResult> {
  return getMerchantEligibility(venueId, input, actor)
}
