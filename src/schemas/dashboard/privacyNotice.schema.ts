import { z } from 'zod'

export const GetPrivacyNoticeSchema = z.object({
  params: z.object({ venueId: z.string().cuid('ID de venue inválido') }),
})

export const UpsertPrivacyNoticeSchema = z.object({
  params: z.object({ venueId: z.string().cuid('ID de venue inválido') }),
  body: z.object({
    content: z.string().min(1, 'El aviso de privacidad es requerido').max(50000, 'El aviso es demasiado largo'),
    language: z.enum(['es', 'en', 'fr']).default('es'),
  }),
})
