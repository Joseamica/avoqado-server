import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ReferralRewardType, ReferralRewardRecurrence } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'
import { planGateMessage } from '../planGate'
import {
  activateReferralProgram,
  updateReferralConfig,
  deactivateReferralProgram,
  type ActivateInput,
  type TierRewardInput,
} from '@/services/referrals/referralProgram.service'
import { getReferralSummary } from '@/services/referrals/referralReads.service'

/** Mirrors the dashboard's per-tier reward Zod shape (src/schemas/dashboard/referrals.schemas.ts). */
const tierRewardShape = {
  tierLevel: z.union([z.literal(1), z.literal(2), z.literal(3)]).describe('Nivel del tier: 1, 2 o 3'),
  rewardType: z
    .nativeEnum(ReferralRewardType)
    .describe(
      'Tipo de premio: PERCENT_COUPON (cupón de % de un solo uso), PERMANENT_DISCOUNT (% automático permanente en todas las compras) o FREE_PRODUCT (una unidad gratis de un producto del catálogo)',
    ),
  recurrence: z
    .nativeEnum(ReferralRewardRecurrence)
    .optional()
    .describe('ONE_TIME (default, aplica a todos los tipos) o MONTHLY (solo relevante para FREE_PRODUCT)'),
  rewardPercent: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe('Porcentaje del premio (0-100). Requerido para PERCENT_COUPON / PERMANENT_DISCOUNT'),
  rewardProductId: z
    .string()
    .min(1)
    .optional()
    .describe('ID del producto que se regala. Requerido para FREE_PRODUCT — debe pertenecer al mismo venue'),
  rewardQuantity: z.number().int().min(1).optional().describe('Cantidad de unidades del producto gratis (default 1)'),
}
const tierRewardZod = z.object(tierRewardShape)

export function registerReferralTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'referral_status',
    'The referral / "recomienda y gana" program settings for a venue you can access: whether it is active, the discount % a new referred customer gets, how many referrals unlock tier 1/2/3, how many days an unlocked coupon lasts, and the per-tier reward configuration (type/percent/product/quantity/recurrence). Also returns this month\'s referral activity summary (counts vs last month, conversion rate, coupons emitted, top referrer). Pass venueId. Answers "¿cómo funciona mi programa de referidos? ¿cuántas referencias van este mes?".',
    {
      venueId: z.string().describe('Venue whose referral program to read (must be in your scope)'),
    },
    async ({ venueId }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('referral:read', venueId)
      const gate = await planGateMessage(venueId, 'REFERRAL_PROGRAM', 'El programa de referidos')
      if (gate) return text({ ok: false, planRequired: true, error: gate })

      // Both reads are cheap/O(1) per venue: findUnique by unique venueId + a bounded
      // include, and getReferralSummary is 6 indexed count/findFirst aggregates
      // (no findMany over all customers/referrals) — safe to run together on every call.
      const [config, summary] = await Promise.all([
        prisma.referralProgramConfig.findUnique({
          where: { venueId },
          include: { tierRewards: { where: { active: true }, orderBy: { tierLevel: 'asc' } } },
        }),
        getReferralSummary(venueId),
      ])

      return text({
        venueId,
        configured: !!config,
        program: config
          ? {
              active: config.active,
              newCustomerDiscountPercent: Number(config.newCustomerDiscountPercent),
              tier1ReferralsRequired: config.tier1ReferralsRequired,
              tier2ReferralsRequired: config.tier2ReferralsRequired,
              tier3ReferralsRequired: config.tier3ReferralsRequired,
              rewardCouponExpiryDays: config.rewardCouponExpiryDays,
              codePrefix: config.codePrefix,
              tierRewards: config.tierRewards.map(r => ({
                tierLevel: r.tierLevel,
                rewardType: r.rewardType,
                recurrence: r.recurrence,
                rewardPercent: r.rewardPercent != null ? Number(r.rewardPercent) : null,
                rewardProductId: r.rewardProductId,
                rewardQuantity: r.rewardQuantity,
              })),
            }
          : null,
        summaryThisMonth: {
          referralsThisMonth: summary.referralsThisMonth,
          referralsPrevMonth: summary.referralsPrevMonth,
          conversionRate: summary.conversionRate,
          qualifiedThisMonth: summary.qualifiedThisMonth,
          pendingThisMonth: summary.pendingThisMonth,
          couponsEmittedThisMonth: summary.couponsEmittedThisMonth,
          topReferrer: summary.topReferrer
            ? {
                name: `${summary.topReferrer.firstName ?? ''} ${summary.topReferrer.lastName ?? ''}`.trim() || '(sin nombre)',
                referralCount: summary.topReferrer.referralCount,
                referralTier: summary.topReferrer.referralTier,
              }
            : null,
        },
      })
    },
  )

  server.tool(
    'configure_referral',
    'Configure the referral / "recomienda y gana" PROGRAM of a venue you can access: activate/deactivate it, set the new-customer discount %, the referral counts needed per tier (1/2/3), the coupon expiry days, and per-tier rewards (percent coupon, permanent discount, or free product). Pass active:true to activate — the FIRST TIME this requires newCustomerDiscountPercent + all 3 tier thresholds + rewardCouponExpiryDays (later re-activations reuse the current values for anything you omit). Pass active:false + reason to deactivate (preserves all history, non-destructive). Omit active to just edit settings on an already-active program — only the fields you pass are changed. Editing a tier level supersedes ALL its previous active rewards (versioned, never physically deleted). This WRITES program settings; requires referral:configure.',
    {
      venueId: z.string().describe('Venue whose program to configure (must be in your scope)'),
      active: z
        .boolean()
        .optional()
        .describe('true = activate/re-activate the program, false = deactivate it, omit = just edit settings on an already-active program'),
      reason: z.string().optional().describe('Why you are deactivating — only used with active:false (default: "Desactivado vía MCP")'),
      newCustomerDiscountPercent: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe('% de descuento que recibe el nuevo cliente referido en su primera compra'),
      tier1ReferralsRequired: z.number().int().min(1).optional().describe('Referencias necesarias para desbloquear el tier 1'),
      tier2ReferralsRequired: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Referencias necesarias para desbloquear el tier 2 (debe ser mayor que tier1)'),
      tier3ReferralsRequired: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Referencias necesarias para desbloquear el tier 3 (debe ser mayor que tier2)'),
      rewardCouponExpiryDays: z.number().int().min(1).optional().describe('Días de vigencia del cupón emitido al desbloquear un tier'),
      codePrefix: z.string().min(1).max(8).optional().describe('Prefijo de los códigos de referido generados (default: slug del venue)'),
      welcomeMessageTemplate: z.string().optional().describe('Plantilla del mensaje de bienvenida (es-MX) enviado al nuevo referidor'),
      tierUpMessageTemplate: z
        .string()
        .optional()
        .describe('Plantilla del mensaje (es-MX) enviado cuando un cliente desbloquea un nuevo tier'),
      tiers: z
        .array(tierRewardZod)
        .optional()
        .describe(
          'Configuración de premios por tier. Omitir deja los premios existentes de esos niveles sin cambios; editar un nivel reemplaza (versiona) TODOS sus premios activos anteriores.',
        ),
    },
    async ({
      venueId,
      active,
      reason,
      newCustomerDiscountPercent,
      tier1ReferralsRequired,
      tier2ReferralsRequired,
      tier3ReferralsRequired,
      rewardCouponExpiryDays,
      codePrefix,
      welcomeMessageTemplate,
      tierUpMessageTemplate,
      tiers,
    }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('referral:configure', venueId) // write gate (per-venue role)
      const gate = await planGateMessage(venueId, 'REFERRAL_PROGRAM', 'El programa de referidos')
      if (gate) return text({ ok: false, planRequired: true, error: gate })

      const existing = await prisma.referralProgramConfig.findUnique({ where: { venueId } })

      try {
        // --- Deactivate: only valid when a config row already exists. -----------
        if (active === false) {
          if (!existing) {
            return text({ ok: false, error: 'El programa de referidos no está configurado; no hay nada que desactivar.' })
          }
          const deactivateReason = reason ?? 'Desactivado vía MCP'
          await deactivateReferralProgram({ venueId, reason: deactivateReason })
          await auditMcpWrite(scope, {
            action: 'REFERRAL_CONFIG_UPDATED',
            entity: 'ReferralProgramConfig',
            entityId: existing.id,
            venueId,
            data: { active: false, reason: deactivateReason },
          })
          return text({ ok: true, program: { active: false } })
        }

        // --- Activate / re-activate: either explicitly requested (active:true), --
        // --- or implicit because there's no config row yet (first-time setup). ---
        if (active === true || !existing) {
          // Re-activation of an already-existing (paused) program reuses whatever
          // scalar isn't supplied from the current row — only a brand-new venue
          // (no `existing` row at all) is forced to supply every core field.
          const resolvedDiscount = newCustomerDiscountPercent ?? (existing ? Number(existing.newCustomerDiscountPercent) : undefined)
          const resolvedTier1 = tier1ReferralsRequired ?? existing?.tier1ReferralsRequired
          const resolvedTier2 = tier2ReferralsRequired ?? existing?.tier2ReferralsRequired
          const resolvedTier3 = tier3ReferralsRequired ?? existing?.tier3ReferralsRequired
          const resolvedExpiry = rewardCouponExpiryDays ?? existing?.rewardCouponExpiryDays

          if (
            resolvedDiscount === undefined ||
            resolvedTier1 === undefined ||
            resolvedTier2 === undefined ||
            resolvedTier3 === undefined ||
            resolvedExpiry === undefined
          ) {
            return text({
              ok: false,
              error:
                'Para activar el programa por primera vez debes pasar: newCustomerDiscountPercent, tier1ReferralsRequired, tier2ReferralsRequired, tier3ReferralsRequired y rewardCouponExpiryDays.',
            })
          }

          const activateInput: ActivateInput = {
            venueId,
            newCustomerDiscountPercent: resolvedDiscount,
            tier1ReferralsRequired: resolvedTier1,
            tier2ReferralsRequired: resolvedTier2,
            tier3ReferralsRequired: resolvedTier3,
            rewardCouponExpiryDays: resolvedExpiry,
            codePrefix: codePrefix ?? existing?.codePrefix ?? undefined,
            welcomeMessageTemplate,
            tierUpMessageTemplate,
            tiers: tiers as TierRewardInput[] | undefined,
          }
          await activateReferralProgram(activateInput)

          const cfg = await prisma.referralProgramConfig.findUnique({ where: { venueId }, select: { id: true, active: true } })
          await auditMcpWrite(scope, {
            action: 'REFERRAL_CONFIG_UPDATED',
            entity: 'ReferralProgramConfig',
            entityId: cfg?.id ?? venueId,
            venueId,
            data: { activated: true, ...activateInput },
          })
          return text({ ok: true, program: { active: cfg?.active ?? true } })
        }

        // --- Ongoing edit: program already active, `active` not toggled. --------
        const patch: Partial<ActivateInput> = {}
        if (newCustomerDiscountPercent !== undefined) patch.newCustomerDiscountPercent = newCustomerDiscountPercent
        if (tier1ReferralsRequired !== undefined) patch.tier1ReferralsRequired = tier1ReferralsRequired
        if (tier2ReferralsRequired !== undefined) patch.tier2ReferralsRequired = tier2ReferralsRequired
        if (tier3ReferralsRequired !== undefined) patch.tier3ReferralsRequired = tier3ReferralsRequired
        if (rewardCouponExpiryDays !== undefined) patch.rewardCouponExpiryDays = rewardCouponExpiryDays
        if (codePrefix !== undefined) patch.codePrefix = codePrefix
        if (welcomeMessageTemplate !== undefined) patch.welcomeMessageTemplate = welcomeMessageTemplate
        if (tierUpMessageTemplate !== undefined) patch.tierUpMessageTemplate = tierUpMessageTemplate

        if (Object.keys(patch).length === 0 && (!tiers || tiers.length === 0)) {
          return text({ ok: false, error: 'No pasaste ningún campo para configurar.' })
        }

        await updateReferralConfig({ venueId, patch, tiers: tiers as TierRewardInput[] | undefined })

        const cfg = await prisma.referralProgramConfig.findUnique({ where: { venueId }, select: { id: true, active: true } })
        await auditMcpWrite(scope, {
          action: 'REFERRAL_CONFIG_UPDATED',
          entity: 'ReferralProgramConfig',
          entityId: cfg?.id ?? venueId,
          venueId,
          data: { ...patch, tiers },
        })
        return text({ ok: true, program: { active: cfg?.active ?? true } })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )
}
