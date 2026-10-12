import { z } from 'zod'
import { StaffRole, WorkRelation, PayComponentKind } from '@prisma/client'
import { venueParamsSchema, fechaSchema } from './staffPay.schema'

const relacion = z.nativeEnum(WorkRelation, { errorMap: () => ({ message: 'Relación inválida' }) }).nullable()
const sino = z.boolean({ invalid_type_error: 'Debe ser sí o no' })
const numero = z.coerce.number({ invalid_type_error: 'Debe ser un número' }).int('Debe ser un número entero')
// El servidor impone el tope (100) aunque el cliente pida más (bounded-queries).
const paginacion = z.object({
  limit: numero
    .min(1, 'El límite mínimo es 1')
    .optional()
    .transform(v => (v === undefined ? undefined : Math.min(v, 100))),
  offset: numero.min(0, 'El desplazamiento no puede ser negativo').optional(),
})
const puestoId = z.string().cuid('Puesto inválido')
const personaId = z.string().cuid('Persona inválida')
const asignacionId = z.string().cuid('Asignación inválida')

export const listarPuestosSchema = z.object({
  params: venueParamsSchema,
  // `z.coerce.boolean()` leería «false» como verdadero: sólo «true» incluye archivados.
  query: paginacion.extend({
    includeArchived: z
      .enum(['true', 'false'], { errorMap: () => ({ message: 'includeArchived debe ser true o false' }) })
      .transform(v => v === 'true')
      .optional(),
  }),
})
export const crearPuestoSchema = z.object({
  params: venueParamsSchema,
  body: z.object({
    name: z
      .string({ required_error: 'El nombre es obligatorio' })
      .trim()
      .min(1, 'El nombre es obligatorio')
      .max(60, 'Máximo 60 caracteres'),
    // SUPERADMIN es de la plataforma, no un rol que un puesto pueda sugerir.
    suggestedRole: z
      .nativeEnum(StaffRole, { errorMap: () => ({ message: 'Rol inválido' }) })
      .refine(r => r !== StaffRole.SUPERADMIN, 'Rol inválido'),
    suggestedRelation: relacion.optional(),
    tracksAttendanceDefault: sino.optional(),
    componentKinds: z
      .array(z.nativeEnum(PayComponentKind, { errorMap: () => ({ message: 'Forma de pago inválida' }) }))
      .max(5, 'Máximo 5 formas de pago')
      .optional(),
    color: z.string().max(20, 'Color inválido').nullable().optional(),
    icon: z.string().max(40, 'Ícono inválido').nullable().optional(),
  }),
})
export const editarPuestoSchema = z.object({
  params: venueParamsSchema.extend({ positionId: puestoId }),
  body: crearPuestoSchema.shape.body.partial(),
})
export const archivarPuestoSchema = z.object({ params: venueParamsSchema.extend({ positionId: puestoId }) })
export const historialSchema = z.object({ params: venueParamsSchema.extend({ staffId: personaId }), query: paginacion })
export const asignarSchema = z.object({
  params: venueParamsSchema.extend({ staffId: personaId }),
  body: z.object({ positionId: puestoId, relation: relacion.optional(), fecha: fechaSchema.optional(), tracksAttendance: sino.optional() }),
})
export const cambiarSchema = z.object({
  params: venueParamsSchema.extend({ assignmentId: asignacionId }),
  body: z.object({ positionId: puestoId.optional(), relation: relacion.optional(), fecha: fechaSchema.optional() }),
})
export const terminarSchema = z.object({
  params: venueParamsSchema.extend({ assignmentId: asignacionId }),
  body: z.object({ fecha: fechaSchema.optional() }),
})
export const personaSchema = z.object({ params: venueParamsSchema.extend({ staffId: personaId }) })
