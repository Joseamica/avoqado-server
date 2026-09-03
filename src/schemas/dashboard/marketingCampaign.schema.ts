// src/schemas/dashboard/marketingCampaign.schema.ts
import { z } from 'zod'
import { CustomerCampaignAudience } from '@prisma/client'

/**
 * Esquemas de las rutas de campañas de correo a clientes — Fase 1C-A, Task 6.
 *
 * `bloques` viaja como `z.unknown()` a propósito: el catálogo exacto de bloques
 * (`bloquesCampanaSchema`, Fase 1A Task 1) ya lo valida `guardarBorrador` con un
 * mensaje específico de qué bloque falló — duplicar esa forma aquí sólo produciría
 * un segundo mensaje de error más genérico para el mismo problema.
 */

const idVenue = z.string().cuid('ID de venue inválido')
const idCampana = z.string().cuid('ID de campaña inválido')

export const listarCampanasSchema = z.object({
  params: z.object({ venueId: idVenue }),
  query: z.object({
    page: z.coerce.number().int('La página debe ser un entero').positive('La página debe ser mayor a 0').optional(),
    pageSize: z.coerce
      .number()
      .int('El tamaño de página debe ser un entero')
      .positive('El tamaño de página debe ser mayor a 0')
      .max(100, 'El tamaño de página no puede superar 100')
      .optional(),
  }),
})

export const campanaParamsSchema = z.object({
  params: z.object({ venueId: idVenue, id: idCampana }),
})

const cuerpoCampana = {
  name: z.string().trim().min(1, 'El nombre de la campaña es requerido').max(150, 'El nombre es demasiado largo'),
  subject: z.string().trim().min(1, 'El asunto es requerido').max(200, 'El asunto es demasiado largo'),
  bloques: z.unknown(),
  audience: z.nativeEnum(CustomerCampaignAudience, { errorMap: () => ({ message: 'La audiencia no es válida' }) }),
  customerGroupId: z.string().cuid('ID de grupo inválido').optional(),
  tags: z.array(z.string().trim().min(1, 'Una etiqueta no puede estar vacía')).optional(),
  scheduledFor: z.coerce.date({ errorMap: () => ({ message: 'La fecha de agenda no es válida' }) }).optional(),
}

export const crearCampanaSchema = z.object({
  params: z.object({ venueId: idVenue }),
  body: z.object(cuerpoCampana),
})

export const editarCampanaSchema = z.object({
  params: z.object({ venueId: idVenue, id: idCampana }),
  body: z.object(cuerpoCampana),
})

export const publicarCampanaSchema = z.object({
  params: z.object({ venueId: idVenue, id: idCampana }),
  body: z.object({
    token: z.string().trim().min(1, 'El token de confirmación es requerido'),
  }),
})
