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

export const tableParamsSchema = venueParamsSchema.extend({ tableId: z.string().cuid('Tabla inválida') })
export const crearTablaSchema = z.object({
  name: z.string().trim().min(1, 'Escribe un nombre').max(80, 'Máximo 80 caracteres'),
  productIds: z.array(z.string().cuid('Producto inválido')).max(200, 'Demasiados productos').default([]),
})
export const publicarVersionSchema = z.object({
  effectiveFrom: fechaSchema,
  countMode: z.enum(['BOOKED', 'ATTENDED'], { errorMap: () => ({ message: 'Modo de conteo inválido' }) }),
  maxCount: z.number().int('Debe ser un número entero').min(0, 'Mínimo 0').max(500, 'Máximo 500 lugares'),
  cells: z
    .array(
      z.object({
        payLevelId: z.string().cuid('Nivel inválido'),
        count: z.number().int('Debe ser un número entero').min(0, 'Mínimo 0'),
        amount: z.number().min(0, 'El monto no puede ser negativo').max(1_000_000, 'Monto demasiado grande'),
      }),
    )
    .max(20_000, 'Demasiadas celdas'),
  simular: z.boolean().optional(),
})
export const archivarTablaSchema = z.object({ archivedFrom: fechaSchema })

// Reporte del periodo abierto (spec §6.2): renglones paginados con tope duro de 100.
const sedeSchema = z.string().cuid('Sede inválida')
export const reporteQuerySchema = z.object({
  fecha: fechaSchema.optional(),
  sede: sedeSchema.optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export const cursorQuerySchema = z.object({
  fecha: fechaSchema.optional(),
  sede: sedeSchema.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
