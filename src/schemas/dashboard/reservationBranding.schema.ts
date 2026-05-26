import { z } from 'zod'
import { BRANDING_FONT_IDS } from '@/services/dashboard/branding.shared'

export const reservationBrandingBodySchema = z.object({
  showLogo: z.boolean().optional(),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'El color debe ser un código HEX de 6 dígitos (ej. #006aff)')
    .nullable()
    .optional(),
  buttonShape: z.enum(['rounded', 'square', 'pill']).optional(),
  fontFamily: z.enum(BRANDING_FONT_IDS as unknown as [string, ...string[]]).optional(),
  showHeroImage: z.boolean().optional(),
  showDescriptions: z.boolean().optional(),
  showDuration: z.boolean().optional(),
  showPrices: z.boolean().optional(),
})

export const updateReservationBrandingSchema = z.object({
  params: z.object({ venueId: z.string().min(1, 'Venue ID es requerido') }),
  body: reservationBrandingBodySchema,
})
