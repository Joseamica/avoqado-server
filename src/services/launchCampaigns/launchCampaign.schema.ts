/**
 * S4 — validación de la ficha de campaña (spec 2026-09-17 § 3.4).
 *
 * 🔴 UNIDADES: los importes de este archivo son CENTAVOS enteros CON IVA — excepción declarada
 * a la regla «la plataforma trabaja en PESOS 1:1» (`.claude/rules/critical-warnings.md`), porque
 * son literalmente `price.unit_amount` y `coupon.amount_off` de Stripe. El superadmin los captura
 * en pesos y los convierte ANTES de llamar; aquí ya llegan en centavos.
 */
import { z } from 'zod'
// 🔴 Los enums llegan como listas de cadenas, NO como el objeto de `@prisma/client`: dentro de
// Jest ese objeto viene sin los enums nuevos y un `z.nativeEnum(undefined)` revienta al cargar
// el módulo. Ver `launchCampaignEnums.ts` para la medición.
import { CAMPAIGN_CHANNEL_VALUES, CAMPAIGN_STATUS_VALUES, CAMPAIGN_VERTICAL_VALUES, REDEMPTION_STATUS_VALUES } from './launchCampaignEnums'
import { STRIPE_MIN_CHARGE_CENTS_MXN } from './launchOfferMath'

/** Código canónico que VIAJA (formulario, MCP, atribución). 3 a 32, mayúsculas. */
export const LAUNCH_CAMPAIGN_CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,31}$/
/** Segmento de URL de la landing: `/oferta/<landingSlug>`. */
export const LANDING_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const code = z.string().trim().toUpperCase().regex(LAUNCH_CAMPAIGN_CODE_RE, 'Código: 3-32 letras, números, guiones o guiones bajos')
const slug = z.string().trim().toLowerCase().min(3).max(60).regex(LANDING_SLUG_RE, 'Slug: minúsculas y guiones')

/**
 * Los cuatro campos que DEFINEN el dinero. Se separan porque §2.1 los congela en cuanto la
 * ficha se activa: quedan bloqueados juntos o no queda bloqueado ninguno.
 */
export const offerFields = z.object({
  planTier: z.enum(['PRO', 'PREMIUM']),
  billingInterval: z.literal('MONTHLY').default('MONTHLY'),
  advertisedPriceCents: z.number().int().min(STRIPE_MIN_CHARGE_CENTS_MXN, 'Stripe no cobra menos de $10.00 MXN').max(10_000_000),
  discountMonths: z.number().int().min(1).max(24),
})

const copy = {
  headline: z.string().trim().max(120).nullable().default(null),
  subheadline: z.string().trim().max(200).nullable().default(null),
  bullets: z.array(z.string().trim().min(1).max(120)).max(6).default([]),
}

export const createLaunchCampaignBody = offerFields
  .extend({
    code,
    name: z.string().trim().min(3).max(80),
    landingSlug: slug,
    vertical: z.enum(CAMPAIGN_VERTICAL_VALUES).default('ALL'),
    channel: z.enum(CAMPAIGN_CHANNEL_VALUES).nullable().default(null),
    validFrom: z.coerce.date(),
    validUntil: z.coerce.date(),
    redemptionCap: z.number().int().min(1).max(100_000),
    ...copy,
  })
  .refine(b => b.validFrom < b.validUntil, { message: 'La vigencia debe terminar después de empezar', path: ['validUntil'] })

/**
 * 🔴 `expectedUpdatedAt` es OBLIGATORIO: toda edición pasa por revisión optimista (CAS). Sin él,
 * dos pestañas del superadmin abiertas a la vez se pisan en silencio y gana la última — sobre una
 * ficha que decide cuánto se le cobra a un cliente.
 */
export const updateLaunchCampaignBody = createLaunchCampaignBody
  .innerType()
  .omit({ code: true })
  .partial()
  .extend({ expectedUpdatedAt: z.coerce.date() })

export const statusReasonBody = z.object({ reason: z.string().trim().min(3).max(300) })
/** Activar no exige motivo: es el camino feliz. Pausar y terminar sí (`statusReasonBody`). */
export const activateBody = z.object({ reason: z.string().trim().min(3).max(300).optional() })

export const listQuery = z.object({
  status: z.enum(CAMPAIGN_STATUS_VALUES).optional(),
  q: z.string().trim().max(60).optional(),
  page: z.coerce.number().int().min(1).default(1),
  // 🔴 Tope duro de 100 (regla `bounded-queries-and-server-load.md`): sin él, un `pageSize`
  // grande arrastra la tabla entera y su conteo.
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
})

export const redemptionListQuery = z.object({
  status: z.enum(REDEMPTION_STATUS_VALUES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
})

export type CreateLaunchCampaignBody = z.infer<typeof createLaunchCampaignBody>
export type UpdateLaunchCampaignBody = z.infer<typeof updateLaunchCampaignBody>
export type ListLaunchCampaignsQuery = z.infer<typeof listQuery>
export type RedemptionListQuery = z.infer<typeof redemptionListQuery>
