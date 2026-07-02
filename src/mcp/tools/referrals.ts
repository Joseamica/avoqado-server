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

/** Spanish labels for the scalar ReferralProgramConfig fields shown in confirm-gate previews. */
const FIELD_LABELS: Record<string, string> = {
  active: 'Programa activo',
  newCustomerDiscountPercent: 'Descuento a cliente nuevo (%)',
  tier1ReferralsRequired: 'Referencias para nivel 1',
  tier2ReferralsRequired: 'Referencias para nivel 2',
  tier3ReferralsRequired: 'Referencias para nivel 3',
  rewardCouponExpiryDays: 'Vigencia del cupón (días)',
  codePrefix: 'Prefijo de código',
  welcomeMessageTemplate: 'Mensaje de bienvenida',
  tierUpMessageTemplate: 'Mensaje de subida de nivel',
}

/** Formats a single reward row for a human preview, e.g. "cupón 25%" / "5% permanente" / "producto gratis x2". */
function formatTierReward(r: {
  rewardType: ReferralRewardType
  recurrence?: ReferralRewardRecurrence | null
  rewardPercent?: unknown
  rewardQuantity?: number | null
}): string {
  const percent = r.rewardPercent != null ? Number(r.rewardPercent) : null
  if (r.rewardType === ReferralRewardType.PERCENT_COUPON) {
    return `cupón ${percent}%${r.recurrence === ReferralRewardRecurrence.MONTHLY ? ' mensual' : ''}`
  }
  if (r.rewardType === ReferralRewardType.PERMANENT_DISCOUNT) {
    return `${percent}% permanente`
  }
  if (r.rewardType === ReferralRewardType.FREE_PRODUCT) {
    return `producto gratis${r.rewardQuantity && r.rewardQuantity > 1 ? ` x${r.rewardQuantity}` : ''}`
  }
  return String(r.rewardType)
}

/** Joins every reward configured for one tier level into a single readable string (a level can carry >1 reward). */
function formatTierGroup(
  rewards: Array<{
    rewardType: ReferralRewardType
    recurrence?: ReferralRewardRecurrence | null
    rewardPercent?: unknown
    rewardQuantity?: number | null
  }>,
): string {
  if (!rewards || rewards.length === 0) return 'sin premio'
  return rewards.map(formatTierReward).join(' + ')
}

/** Builds the "nivel N: actual → nuevo" preview rows for the tier levels present in the incoming `tiers` payload. */
function buildTierPreview(
  currentRewards: Array<{
    tierLevel: number
    rewardType: ReferralRewardType
    recurrence?: ReferralRewardRecurrence | null
    rewardPercent?: unknown
    rewardQuantity?: number | null
  }>,
  incomingTiers: TierRewardInput[] | undefined,
): Array<{ tierLevel: number; from: string; to: string }> {
  if (!incomingTiers || incomingTiers.length === 0) return []
  const levels = Array.from(new Set(incomingTiers.map(t => t.tierLevel))).sort((a, b) => a - b)
  return levels.map(tierLevel => ({
    tierLevel,
    from: formatTierGroup((currentRewards ?? []).filter(r => r.tierLevel === tierLevel)),
    to: formatTierGroup(incomingTiers.filter(t => t.tierLevel === tierLevel)),
  }))
}

/** Renders the scalar + tier preview rows into the Spanish confirm-gate message. */
function buildConfirmMessage(
  intro: string,
  scalarPreview: Array<{ label: string; from: unknown; to: unknown }>,
  tierPreview: Array<{ tierLevel: number; from: string; to: string }>,
): string {
  const lines = [
    ...scalarPreview.map(p => `• ${p.label}: ${p.from ?? '(sin definir)'} → ${p.to}`),
    ...tierPreview.map(t => `• Nivel ${t.tierLevel}: ${t.from} → ${t.to}`),
  ]
  return `${intro}\n${lines.join('\n')}\n\nConfirma con el operador; luego vuelve a llamar con confirm:true para aplicar.`
}

export function registerReferralTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'referral_status',
    'La configuración del programa de referidos / "recomienda y gana" de un venue al que tienes acceso: si está activo, el % de descuento que recibe un nuevo cliente referido, cuántas referencias desbloquean el nivel 1/2/3, cuántos días dura vigente un cupón desbloqueado, y la configuración de premios por nivel (tipo/porcentaje/producto/cantidad/recurrencia). También devuelve el resumen de actividad de referidos de este mes (conteos vs. mes pasado, tasa de conversión, cupones emitidos, mejor referidor). Pasa venueId. Responde "¿cómo funciona mi programa de referidos? ¿cuántas referencias van este mes?".',
    {
      venueId: z.string().describe('Venue cuyo programa de referidos quieres leer (debe estar en tu scope)'),
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
    '🔴 CRÍTICO (cambia la economía de premios del programa). Configura el PROGRAMA de referidos / "recomienda y gana" de un venue al que tienes acceso: actívalo/desactívalo, define el % de descuento al cliente nuevo, las referencias necesarias por nivel (1/2/3), los días de vigencia del cupón, y los premios por nivel (cupón %, descuento permanente o producto gratis). Pasa active:true para activar — la PRIMERA VEZ esto requiere newCustomerDiscountPercent + los 3 umbrales de nivel + rewardCouponExpiryDays (reactivaciones posteriores reusan los valores actuales de lo que omitas). Pasa active:false + reason para desactivar (preserva todo el historial, no destructivo). Omite active para solo editar configuración de un programa ya activo — solo se cambian los campos que pasas. Editar un nivel reemplaza (versiona) TODOS sus premios activos anteriores. Por DEFAULT solo PREVISUALIZA (actual → nuevo); llama de nuevo con confirm:true para aplicar. Esto ESCRIBE la configuración del programa; requiere referral:configure.',
    {
      venueId: z.string().describe('Venue cuyo programa quieres configurar (debe estar en tu scope)'),
      active: z
        .boolean()
        .optional()
        .describe(
          'true = activar/reactivar el programa, false = desactivarlo, omitir = solo editar configuración de un programa ya activo',
        ),
      reason: z.string().optional().describe('Por qué estás desactivando — solo se usa con active:false (default: "Desactivado vía MCP")'),
      confirm: z
        .boolean()
        .optional()
        .describe('Debe ser true para aplicar los cambios; sin él se devuelve una vista previa (actual → nuevo) sin escribir nada'),
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
      confirm,
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

      const existing = await prisma.referralProgramConfig.findUnique({
        where: { venueId },
        include: { tierRewards: { where: { active: true } } },
      })

      try {
        // --- Deactivate: only valid when a config row already exists. -----------
        if (active === false) {
          if (!existing) {
            return text({ ok: false, error: 'El programa de referidos no está configurado; no hay nada que desactivar.' })
          }
          const deactivateReason = reason ?? 'Desactivado vía MCP'

          if (!confirm) {
            const preview = [{ label: FIELD_LABELS.active, from: existing.active ? 'sí' : 'no', to: 'no' }]
            return text({
              ok: false,
              requiresConfirmation: true,
              preview,
              message: buildConfirmMessage(`Esto desactivará el programa de referidos (razón: "${deactivateReason}"):`, preview, []),
            })
          }

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

          if (!confirm) {
            const preview = [
              { label: FIELD_LABELS.active, from: existing?.active ? 'sí' : 'no', to: 'sí' },
              {
                label: FIELD_LABELS.newCustomerDiscountPercent,
                from: existing ? Number(existing.newCustomerDiscountPercent) : null,
                to: resolvedDiscount,
              },
              { label: FIELD_LABELS.tier1ReferralsRequired, from: existing?.tier1ReferralsRequired ?? null, to: resolvedTier1 },
              { label: FIELD_LABELS.tier2ReferralsRequired, from: existing?.tier2ReferralsRequired ?? null, to: resolvedTier2 },
              { label: FIELD_LABELS.tier3ReferralsRequired, from: existing?.tier3ReferralsRequired ?? null, to: resolvedTier3 },
              { label: FIELD_LABELS.rewardCouponExpiryDays, from: existing?.rewardCouponExpiryDays ?? null, to: resolvedExpiry },
            ]
            const tierPreview = buildTierPreview(existing?.tierRewards ?? [], tiers as TierRewardInput[] | undefined)
            return text({
              ok: false,
              requiresConfirmation: true,
              preview,
              tierPreview,
              message: buildConfirmMessage(`Esto ${existing ? 'REACTIVARÁ' : 'ACTIVARÁ'} el programa de referidos:`, preview, tierPreview),
            })
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

        if (!confirm) {
          const preview = Object.entries(patch).map(([key, to]) => ({
            label: FIELD_LABELS[key] ?? key,
            from: existing ? ((existing as unknown as Record<string, unknown>)[key] ?? null) : null,
            to,
          }))
          const tierPreview = buildTierPreview(existing?.tierRewards ?? [], tiers as TierRewardInput[] | undefined)
          return text({
            ok: false,
            requiresConfirmation: true,
            preview,
            tierPreview,
            message: buildConfirmMessage('Esto cambiará la configuración del programa de referidos:', preview, tierPreview),
          })
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
