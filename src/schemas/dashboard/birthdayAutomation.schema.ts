import { z } from 'zod'
import { MAX_DAYS_BEFORE } from '@/services/marketing/birthdayAutomation.service'

const idVenue = z.string().cuid('ID de venue inválido')

export const obtenerAutomatizacionSchema = z.object({
  params: z.object({ venueId: idVenue }),
})

export const guardarAutomatizacionSchema = z.object({
  params: z.object({ venueId: idVenue }),
  body: z.object({
    subject: z.string().trim().min(1, 'El asunto es requerido').max(200, 'El asunto es demasiado largo'),
    bloques: z.unknown(),
    daysBefore: z
      .number()
      .int('Los días de antelación deben ser un número entero')
      .min(0, 'Los días de antelación no pueden ser negativos')
      .max(MAX_DAYS_BEFORE, `No se puede felicitar con más de ${MAX_DAYS_BEFORE} días de antelación`),
    activa: z.boolean({ required_error: 'Hay que decir si la felicitación queda encendida o pausada' }),
  }),
})
