import { z } from 'zod'

import { CUSTOMER_DISPLAY_DESIGN_CAPABILITY } from '../../services/customer-display/customerDisplayDesign.validation'

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
      // — Pantalla del cliente (spec §5.7.2). La app los manda SÓLO si el poll anunció la capacidad; una app vieja no
      // los manda y su cuerpo sigue siendo válido tal cual. —
      customerDisplayDesignVersion: z
        .number({ invalid_type_error: 'La versión de diseño debe ser un número' })
        .int('La versión de diseño debe ser un entero')
        .min(1, 'La versión de diseño mínima es 1')
        .max(CUSTOMER_DISPLAY_DESIGN_CAPABILITY, `La versión de diseño máxima es ${CUSTOMER_DISPLAY_DESIGN_CAPABILITY}`)
        .optional(),
      installationId: z
        .string({ invalid_type_error: 'La instalación debe ser un texto' })
        .min(1, 'La instalación no puede ir vacía')
        .max(64, 'La instalación es demasiado larga')
        .regex(/^[A-Za-z0-9-]+$/, 'La instalación sólo admite letras, números y guiones')
        .optional(),
    })
    .strict()
    .refine(b => (b.customerDisplayDesignVersion === undefined) === (b.installationId === undefined), {
      message: 'La versión de diseño y la instalación van juntas',
      path: ['installationId'],
    }),
  params: z
    .object({
      venueId: z.string().min(1, 'El venue es requerido'),
    })
    .passthrough(),
})

export type ReportDeviceCapabilitiesInput = z.infer<typeof reportDeviceCapabilitiesSchema>['body']
