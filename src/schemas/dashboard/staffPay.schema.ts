import { z } from 'zod'

export const venueParamsSchema = z.object({ venueId: z.string().cuid('Venue ID inválido') })
export const fechaSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (AAAA-MM-DD)')

export const levelParamsSchema = venueParamsSchema.extend({ levelId: z.string().cuid('Nivel inválido') })
export const staffParamsSchema = venueParamsSchema.extend({ staffId: z.string().cuid('Persona inválida') })
export const crearNivelSchema = z.object({ name: z.string().trim().min(1, 'Escribe un nombre').max(60, 'Máximo 60 caracteres') })
export const editarNivelSchema = z.object({
  name: z.string().trim().min(1, 'Escribe un nombre').max(60, 'Máximo 60 caracteres').optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
  archived: z.boolean().optional(),
})
export const asignarNivelSchema = z.object({
  staffId: z.string().cuid('Persona inválida'),
  payLevelId: z.string().cuid('Nivel inválido'),
  effectiveFrom: fechaSchema,
  simular: z.boolean().optional(),
})
export const fechaQuerySchema = z.object({ fecha: fechaSchema.optional() })
