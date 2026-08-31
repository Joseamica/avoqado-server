import { z } from 'zod'

const customerDisplaySchema = z
  .object({
    present: z.boolean({ required_error: 'Falta indicar si existe pantalla de cliente' }),
    invertible: z.boolean({ required_error: 'Falta indicar si la pantalla es invertible' }),
  })
  .strict()
  .refine(display => !display.invertible || display.present, {
    message: 'Una pantalla sólo puede ser invertible cuando está presente',
    path: ['invertible'],
  })

/** PUT /mobile/venues/:venueId/device-capabilities — hechos técnicos observados. */
export const reportDeviceCapabilitiesSchema = z.object({
  body: z
    .object({
      customerDisplay: customerDisplaySchema,
      // Exactamente v1. Un protocolo futuro necesita negociación explícita.
      displayModeProtocolVersion: z.literal(1, {
        errorMap: () => ({ message: 'La versión del protocolo de pantalla debe ser exactamente 1' }),
      }),
    })
    .strict(),
  params: z
    .object({
      venueId: z.string().min(1, 'El venue es requerido'),
    })
    .passthrough(),
})

export type ReportDeviceCapabilitiesInput = z.infer<typeof reportDeviceCapabilitiesSchema>['body']
