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
