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
  // 🔴 `scheduledFor` se QUITÓ del cuerpo a propósito (fix ronda final, revisor): las
  // campañas agendadas están declaradas fuera de alcance de esta fase (spec, Fase 1
  // pendiente), y aceptar el campo aquí sin un job que lo honre era peor que no tenerlo —
  // `campaignEnqueue.service.ts:220` lee `campaign.scheduledFor ?? ahora` para calcular el
  // PERÍODO de la cuota mensual (`periodoDeEnvio`), así que una fecha futura en el cuerpo
  // hacía que el correo saliera HOY pero la cuota se cargara a un mes futuro — el tope que
  // protege la reputación del subdominio de correo quedaba evadible desde el request. Esa
  // lectura en `campaignEnqueue.service.ts` NO se tocó: es correcta para cuando el campo
  // exista de verdad. Lo que se cierra es la puerta que lo dejaba entrar sin que nada lo
  // aplicara. Para devolverlo hace falta: un job que transicione DRAFT/SCHEDULED → ENQUEUED
  // en la fecha agendada, y que el envío real respete esa fecha (hoy publicarCampana manda
  // en minutos, sin importar lo que diga `scheduledFor`).
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
