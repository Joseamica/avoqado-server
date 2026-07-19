/**
 * Zod schemas — Gestión de canales de delivery (DeliveryChannelLink CRUD + pause, Task 10).
 * Mensajes SIEMPRE en español. Shape/formato únicamente — las reglas de negocio
 * (tenant isolation, defaults, llamada al adapter) viven en el service.
 */
import { DeliveryProvider, OrderAcceptanceMode } from '@prisma/client'
import { z } from 'zod'

const DELIVERY_PROVIDER_VALUES = Object.values(DeliveryProvider) as [DeliveryProvider, ...DeliveryProvider[]]
const ORDER_ACCEPTANCE_MODE_VALUES = Object.values(OrderAcceptanceMode) as [OrderAcceptanceMode, ...OrderAcceptanceMode[]]

/** POST /venues/:venueId/channels — vincula un nuevo canal. */
export const createChannelSchema = z.object({
  body: z
    .object({
      provider: z.enum(DELIVERY_PROVIDER_VALUES, { message: 'Proveedor inválido' }),
      externalLocationId: z.string().min(1, 'El ID de ubicación es requerido'),
      externalAccountId: z.string().min(1, 'La cuenta externa no puede estar vacía').optional(),
      orderAcceptanceMode: z.enum(ORDER_ACCEPTANCE_MODE_VALUES, { message: 'Modo de aceptación inválido' }).optional(),
      autoSyncMenu: z.boolean({ message: 'El auto-sync de menú debe ser verdadero o falso' }).optional(),
      config: z.record(z.any()).optional(),
    })
    .strict(),
  params: z.object({ venueId: z.string().min(1, 'El venue es requerido') }).passthrough(),
  query: z.object({}).passthrough().optional(),
})

export type CreateChannelLinkBody = z.infer<typeof createChannelSchema>['body']

/** PATCH /venues/:venueId/channels/:linkId — edita un canal existente. */
export const updateChannelSchema = z.object({
  body: z
    .object({
      externalLocationId: z.string().min(1, 'El ID de ubicación es requerido').optional(),
      externalAccountId: z.string().min(1, 'La cuenta externa no puede estar vacía').nullable().optional(),
      orderAcceptanceMode: z.enum(ORDER_ACCEPTANCE_MODE_VALUES, { message: 'Modo de aceptación inválido' }).optional(),
      autoSyncMenu: z.boolean({ message: 'El auto-sync de menú debe ser verdadero o falso' }).optional(),
      config: z.record(z.any()).nullable().optional(),
    })
    .strict()
    .refine(body => Object.keys(body).length > 0, { message: 'Envía al menos un campo para actualizar' }),
  params: z
    .object({
      venueId: z.string().min(1, 'El venue es requerido'),
      linkId: z.string().min(1, 'El canal es requerido'),
    })
    .passthrough(),
  query: z.object({}).passthrough().optional(),
})

export type UpdateChannelLinkBody = z.infer<typeof updateChannelSchema>['body']

/** POST /venues/:venueId/channels/:linkId/pause — pausa o reactiva un canal. */
export const pauseChannelSchema = z.object({
  body: z
    .object({
      paused: z.boolean({ message: 'El estado de pausa (paused) es requerido' }),
    })
    .strict(),
  params: z
    .object({
      venueId: z.string().min(1, 'El venue es requerido'),
      linkId: z.string().min(1, 'El canal es requerido'),
    })
    .passthrough(),
  query: z.object({}).passthrough().optional(),
})

export type PauseChannelLinkBody = z.infer<typeof pauseChannelSchema>['body']

/** POST /venues/:venueId/activation-request — el dueño solicita activar delivery (self-serve). */
export const createActivationRequestSchema = z.object({
  body: z
    .object({
      requestedChannels: z
        .array(z.enum(['UBER_EATS', 'RAPPI', 'DIDI_FOOD'], { message: 'Canal inválido' }))
        .min(1, 'Selecciona al menos un canal'),
      note: z.string().max(1000, 'La nota es demasiado larga').optional(),
    })
    .strict(),
})

export type CreateActivationRequestBody = z.infer<typeof createActivationRequestSchema>['body']
