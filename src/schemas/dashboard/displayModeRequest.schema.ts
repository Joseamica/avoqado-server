import { z } from 'zod'

const boundedIdentifier = (label: string) =>
  z.string().trim().min(1, `${label} es requerido`).max(128, `${label} no puede exceder 128 caracteres`)

export const createDisplayModeRequestSchema = z.object({
  params: z
    .object({
      venueId: boundedIdentifier('El venue'),
      terminalId: boundedIdentifier('La terminal'),
    })
    .strict(),
  body: z
    .object({
      desiredInverted: z.boolean({ required_error: 'Falta indicar el modo de pantalla solicitado' }),
    })
    .strict(),
})

export const cancelDisplayModeRequestSchema = z.object({
  params: z
    .object({
      venueId: boundedIdentifier('El venue'),
      terminalId: boundedIdentifier('La terminal'),
      requestId: boundedIdentifier('La solicitud'),
    })
    .strict(),
  body: z.object({}).strict(),
})

export type CreateDisplayModeRequestBody = z.infer<typeof createDisplayModeRequestSchema>['body']
