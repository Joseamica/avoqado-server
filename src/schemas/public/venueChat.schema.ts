import { z } from 'zod'

export const createSessionBodySchema = z.object({
  venueSlug: z.string().min(1, 'venueSlug requerido'),
  name: z.string().min(2, 'Nombre demasiado corto').max(80, 'Nombre demasiado largo'),
  email: z.string().email('Email inválido').max(120).optional(),
  message: z.string().min(3, 'Mensaje demasiado corto').max(1500, 'Mensaje demasiado largo'),
  flowOrigin: z.enum(['appointments', 'classes', 'packs']).default('appointments'),
  clientSessionNonce: z.string().uuid('clientSessionNonce debe ser UUID'),
})

export const postMessageBodySchema = z.object({
  body: z.string().min(1, 'Mensaje requerido').max(1500, 'Mensaje demasiado largo'),
  clientMessageId: z.string().uuid('clientMessageId debe ser UUID'),
})

export const pollMessagesQuerySchema = z.object({
  after: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  visible: z.enum(['true', 'false']).optional(),
})

export const sessionParamsSchema = z.object({
  id: z.string().min(1, 'sessionId requerido'),
})

// POST /venue-chat/sessions/:id/resume — proves possession of the on-file
// email and gets a fresh accessToken. Used by the email "you have a reply"
// link (which contains only the sessionId in the URL fragment).
export const resumeSessionBodySchema = z.object({
  email: z.string().email('Email inválido').max(120),
})
