import { z } from 'zod'
import { BRANDING_FONT_IDS } from '@/services/dashboard/branding.shared'
import { PAYMENT_LINK_FONT_IDS } from './paymentLink.schema'

// El DASHBOARD ofrece aquí el mismo selector de 40 fuentes que las ligas de pago; la lista vieja de 28 rechazaba
// 14 de ellas con un 400 («Outfit», Mindform BSF, 22-nov-2026). Se conservan las viejas por si un negocio ya guardó una.
const FUENTES_DE_RESERVACIONES = [...new Set<string>([...PAYMENT_LINK_FONT_IDS, ...BRANDING_FONT_IDS])] as [string, ...string[]]

export const reservationBrandingBodySchema = z.object({
  showLogo: z.boolean().optional(),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'El color debe ser un código HEX de 6 dígitos (ej. #006aff)')
    .nullable()
    .optional(),
  buttonShape: z.enum(['rounded', 'square', 'pill']).optional(),
  fontFamily: z.enum(FUENTES_DE_RESERVACIONES).optional(),
  showHeroImage: z.boolean().optional(),
  showDescriptions: z.boolean().optional(),
  showDuration: z.boolean().optional(),
  showPrices: z.boolean().optional(),
})

export const updateReservationBrandingSchema = z.object({
  params: z.object({ venueId: z.string().min(1, 'Venue ID es requerido') }),
  body: reservationBrandingBodySchema,
})
