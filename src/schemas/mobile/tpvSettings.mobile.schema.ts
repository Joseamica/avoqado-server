/**
 * Zod schemas de TPV SETTINGS para el namespace /mobile (POS iOS/Android).
 * Mensajes en español; shape/formato aquí, reglas de negocio en el controller.
 */
import { z } from 'zod'

/** PATCH /mobile/venues/:venueId/terminals/:terminalId/display-mode — mostrador
 * invertido (cliente ve la pantalla grande, cajero la chica). Es por DISPOSITIVO. */
export const updateDisplayModeSchema = z.object({
  body: z
    .object({
      customerDisplayInverted: z.boolean({ required_error: 'Falta indicar si el mostrador está invertido' }),
    })
    .strict(),
  params: z
    .object({
      venueId: z.string().min(1, 'El venue es requerido'),
      terminalId: z.string().min(1, 'La terminal es requerida'),
    })
    .passthrough(),
})

export type UpdateDisplayModeInput = z.infer<typeof updateDisplayModeSchema>['body']
