import { Prisma } from '@prisma/client'
import { z } from 'zod'

/** La venta de SIM que sube el celular del promotor (App de campo, bloque 0). La llave la crea el celular al tocar. */
export const ventaDeCampoBodySchema = z.object({
  llave: z.string().uuid({ message: 'La llave de la venta debe ser un UUID.' }),
  // Como lo guarda el inventario: sin espacios y en mayúsculas.
  serialNumber: z
    .string()
    .transform(s => s.replace(/\s+/g, '').toUpperCase())
    .pipe(z.string().min(1, { message: 'El número de la SIM es requerido.' }).max(64)),
  precioVisto: z
    .number()
    .nonnegative({ message: 'El precio no puede ser negativo.' })
    .max(99_999_999.99) // la ficha lo guarda en Decimal(10, 2)
    .refine(n => new Prisma.Decimal(n).decimalPlaces() <= 2, { message: 'El precio lleva máximo 2 decimales.' }),
  ocurrioAt: z.string().datetime({ offset: true, message: 'La hora de la venta debe ser ISO 8601.' }).optional(),
  origenHora: z.enum(['RELOJ_ANCLADO', 'RELOJ_DEL_CELULAR']).optional(),
  isPortabilidad: z.boolean().optional(),
  notas: z.string().max(500).optional(),
})

export const ventaDeCampoSchema = z.object({ body: ventaDeCampoBodySchema })

export type VentaDeCampoBody = z.infer<typeof ventaDeCampoBodySchema>

/** Custodia del celular: aceptar varias SIMs (tope 50) o rechazar UNA. */
export const aceptarCustodiaSchema = z.object({
  body: z.object({ serialNumbers: z.array(z.string().min(1)).min(1).max(50) }),
})
export const rechazarCustodiaSchema = z.object({ body: z.object({ serialNumber: z.string().min(1) }) })
