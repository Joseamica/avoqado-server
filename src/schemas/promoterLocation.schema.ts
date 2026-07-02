import { z } from 'zod'

/**
 * Body schema for the TPV promoter-location ingest endpoint
 * (POST /tpv/v1/geolocation/promoter-ping). Shape/format only; venueId + staffId
 * are taken from the auth token (tenant isolation), never from the body.
 * Messages in Spanish (surfaced to the client by validation middleware).
 */
export const recordPromoterPingSchema = z.object({
  body: z.object({
    latitude: z
      .number({ required_error: 'La latitud es requerida', invalid_type_error: 'La latitud debe ser un número' })
      .min(-90, 'La latitud debe estar entre -90 y 90')
      .max(90, 'La latitud debe estar entre -90 y 90'),
    longitude: z
      .number({ required_error: 'La longitud es requerida', invalid_type_error: 'La longitud debe ser un número' })
      .min(-180, 'La longitud debe estar entre -180 y 180')
      .max(180, 'La longitud debe estar entre -180 y 180'),
    accuracy: z
      .number({ invalid_type_error: 'La precisión debe ser un número' })
      .nonnegative('La precisión no puede ser negativa')
      .optional(),
    capturedAt: z.string().datetime({ message: 'capturedAt debe ser una fecha ISO 8601 válida' }).optional(),
    source: z.enum(['PERIODIC', 'CLOCK_IN', 'CLOCK_OUT'], { errorMap: () => ({ message: 'El origen (source) es inválido' }) }).optional(),
  }),
})

export type RecordPromoterPingBody = z.infer<typeof recordPromoterPingSchema>['body']
