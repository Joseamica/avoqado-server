import { z } from 'zod'

export const posOrderPayloadSchema = z.object({
  externalId: z.string().min(1, 'El ID externo es obligatorio'),
  venueId: z.string().cuid('El ID del negocio no es válido'),
  orderNumber: z.string().min(1, 'El número de orden es obligatorio'),
  subtotal: z.number().positive('El subtotal debe ser un número mayor a cero'),
  taxAmount: z.number().min(0, 'El impuesto no puede ser negativo'),
  total: z.number().positive('El total debe ser un número mayor a cero'),
  createdAt: z.string().datetime('La fecha de creación no es válida'),
  posRawData: z.any(),
  discountAmount: z.number().min(0, 'El descuento no puede ser negativo'),
  tipAmount: z.number().min(0, 'La propina no puede ser negativa'),
})
