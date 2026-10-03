import { z } from 'zod'

export const venueParamsSchema = z.object({ venueId: z.string().cuid('Venue ID inválido') })
export const fechaSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (AAAA-MM-DD)')
