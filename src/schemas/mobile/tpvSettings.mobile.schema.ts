/**
 * Zod schemas de TPV SETTINGS para el namespace /mobile (POS iOS/Android).
 * Mensajes en español; shape/formato aquí, reglas de negocio en el controller.
 */
import { z } from 'zod'

const physicalDisplayValue = z.boolean({ required_error: 'Falta indicar si el mostrador está invertido' })
const boundedRequestId = z
  .string({ required_error: 'La solicitud es requerida' })
  .trim()
  .min(1, 'La solicitud es requerida')
  .max(128, 'La solicitud no puede exceder 128 caracteres')

const legacyDisplayModeBody = z
  .object({
    customerDisplayInverted: physicalDisplayValue,
  })
  .strict()

const appliedDisplayModeAckBody = z
  .object({
    customerDisplayInverted: physicalDisplayValue,
    requestId: boundedRequestId,
    outcome: z.literal('APPLIED'),
  })
  .strict()

const rejectedDisplayModeAckBody = z
  .object({
    customerDisplayInverted: physicalDisplayValue,
    requestId: boundedRequestId,
    outcome: z.literal('REJECTED'),
    resultCode: z.enum(['DISPLAY_NOT_PRESENT', 'DISPLAY_NOT_INVERTIBLE', 'APPLY_FAILED', 'LOCAL_OVERRIDE', 'DEVICE_RETIRED'], {
      required_error: 'Un rechazo requiere indicar el resultado',
    }),
  })
  .strict()

/** PATCH /mobile/venues/:venueId/terminals/:terminalId/display-mode — conserva
 * el reporte local legacy y añade el ACK v1 tipado del propio dispositivo. */
export const updateDisplayModeSchema = z.object({
  body: z.union([legacyDisplayModeBody, appliedDisplayModeAckBody, rejectedDisplayModeAckBody]),
  params: z
    .object({
      venueId: z.string().trim().min(1, 'El venue es requerido').max(128, 'El venue no puede exceder 128 caracteres'),
      terminalId: z.string().trim().min(1, 'La terminal es requerida').max(128, 'La terminal no puede exceder 128 caracteres'),
    })
    .strict(),
})

export type UpdateDisplayModeInput = z.infer<typeof updateDisplayModeSchema>['body']

/**
 * PATCH /mobile/venues/:venueId/terminals/:terminalId/settings — el POS configura SU PROPIA ficha.
 *
 * 🔴 Aquí sólo se declara la FORMA (qué llaves existen y de qué tipo). **Quién puede cambiar qué NO
 * se decide en este archivo**: lo decide `assertSettingsConfigurable` por tipo de aparato
 * (`device-capabilities.service.ts`), que es el único lugar donde vive esa distinción. Si esa regla
 * viviera también aquí, tendríamos dos catálogos que se desincronizan en silencio.
 *
 * `.strict()` rechaza cualquier llave que no esté listada, así que el guard es la segunda barrera:
 * el día que alguien agregue una llave a este schema sin pensar en los aparatos, el guard la rebota.
 */
const configurableTpvSettingsBody = z
  .object({
    showReviewScreen: z.boolean().optional(),
    showTipScreen: z.boolean().optional(),
    // Espejo EXACTO de lo que ya valida el editor del dashboard (1 a 100, sin repetidos, máximo
    // 6): si las dos superficies aceptaran cosas distintas, el mismo negocio acabaría con dos
    // listas según dónde las editó. La lista vacía se rechaza aparte para poder explicarla.
    tipSuggestions: z
      .array(
        z
          .number({ invalid_type_error: 'Los porcentajes de propina deben ser números' })
          .int('Los porcentajes de propina deben ser números enteros')
          .min(1, 'Un porcentaje de propina debe ser al menos 1')
          .max(100, 'Un porcentaje de propina no puede pasar de 100'),
      )
      .min(1, 'Deja al menos un porcentaje de propina')
      .max(6, 'No puedes ofrecer más de 6 porcentajes de propina')
      .refine(valores => new Set(valores).size === valores.length, 'No repitas el mismo porcentaje')
      .optional(),
  })
  .strict()

export const updateTerminalSettingsSchema = z.object({
  body: configurableTpvSettingsBody,
  params: z
    .object({
      venueId: z.string().trim().min(1, 'El venue es requerido').max(128, 'El venue no puede exceder 128 caracteres'),
      terminalId: z.string().trim().min(1, 'La terminal es requerida').max(128, 'La terminal no puede exceder 128 caracteres'),
    })
    .strict(),
})

export type UpdateTerminalSettingsInput = z.infer<typeof updateTerminalSettingsSchema>['body']
