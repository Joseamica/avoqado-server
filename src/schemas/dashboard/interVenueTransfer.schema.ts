import { InterVenueTransferMode, InterVenueTransferStatus, InterVenueTransferVarianceReason } from '@prisma/client'
import { z } from 'zod'

const id = z.string().min(1, 'El identificador es requerido')
const quantity = z.number().finite('La cantidad debe ser finita').positive('La cantidad debe ser mayor que cero')

const params = z.object({ venueId: id, transferId: id })

export const ListInterVenueTransfersSchema = z.object({
  params: z.object({ venueId: id }),
  query: z.object({
    status: z.nativeEnum(InterVenueTransferStatus).optional(),
    direction: z.enum(['incoming', 'outgoing']).optional(),
    search: z.string().trim().min(1).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  }),
})

export const GetInterVenueTransferSchema = z.object({ params })

export const CreateInterVenueTransferSchema = z.object({
  params: z.object({ venueId: id }),
  body: z
    .object({
      mode: z.nativeEnum(InterVenueTransferMode),
      sourceVenueId: id,
      destinationVenueId: id,
      externalReference: z.string().trim().min(1).max(120).optional(),
      notes: z.string().trim().max(2000).optional(),
      fiscalUuid: z.string().trim().min(1).max(64).optional(),
      fiscalReference: z.string().trim().min(1).max(120).optional(),
      items: z
        .array(
          z.object({
            sourceRawMaterialId: id,
            destinationRawMaterialId: id,
            quantity,
            notes: z.string().trim().max(1000).optional(),
          }),
        )
        .min(1, 'Agrega al menos un insumo al traslado'),
    })
    .refine(data => data.sourceVenueId !== data.destinationVenueId, {
      message: 'El origen y el destino deben ser sucursales distintas',
      path: ['destinationVenueId'],
    }),
})

export const TransferDecisionSchema = z.object({
  params,
  body: z.object({ reason: z.string().trim().min(3, 'El motivo debe tener al menos 3 caracteres').max(2000) }),
})

export const TransferActionSchema = z.object({ params, body: z.object({}).optional() })

export const DispatchInterVenueTransferSchema = z.object({
  params,
  body: z.object({
    items: z
      .array(
        z.object({
          itemId: id,
          quantity,
          shortfallReason: z.string().trim().min(3, 'El motivo debe tener al menos 3 caracteres').max(1000).optional(),
        }),
      )
      .min(1, 'Agrega al menos un insumo a la salida'),
  }),
})

export const ReceiveInterVenueTransferSchema = z.object({
  params,
  body: z.object({
    notes: z.string().trim().max(2000).optional(),
    items: z.array(z.object({ itemId: id, quantity })).min(1, 'Agrega al menos un insumo a la recepción'),
  }),
})

export const ResolveInterVenueTransferVarianceSchema = z.object({
  params,
  body: z.object({
    notes: z.string().trim().max(2000).optional(),
    items: z
      .array(
        z.object({
          itemId: id,
          quantity,
          reason: z.nativeEnum(InterVenueTransferVarianceReason),
          notes: z.string().trim().max(1000).optional(),
        }),
      )
      .min(1, 'Agrega al menos una diferencia por resolver'),
  }),
})

export const ConsolidatedInterVenueInventorySchema = z.object({
  params: z.object({ venueId: id }),
  query: z.object({ search: z.string().trim().min(1).optional() }),
})
