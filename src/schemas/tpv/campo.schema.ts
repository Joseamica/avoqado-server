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

/** La checada del celular (Tarea 6). La persona sale del token: no hay PIN. La llave la crea el celular al tocar. */
const checadaBase = {
  llave: z.string().uuid({ message: 'La llave de la checada debe ser un UUID.' }),
  ocurrioAt: z.string().datetime({ offset: true, message: 'La hora de la checada debe ser ISO 8601.' }).optional(),
  origenHora: z.enum(['RELOJ_ANCLADO', 'RELOJ_DEL_CELULAR']).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  accuracy: z.number().nonnegative().optional(),
  ubicacionFalsa: z.boolean().optional(),
}
const foto = z.string().url().max(2048).optional()

export const entradaDeCampoBodySchema = z.object({ ...checadaBase, checkInPhotoUrl: foto, facadePhotoUrl: foto })

/** La salida nombra su entrada: por `timeEntryId` (entrada hecha en una PAX) o por `llaveEntrada` (la entrada sigue en la cola). */
export const salidaDeCampoBodySchema = z
  .object({
    ...checadaBase,
    // Sin `.cuid()`: un id raro de la cola sale 404 («esa entrada no existe»), igual que uno que no está.
    timeEntryId: z.string().min(1).max(64).optional(),
    llaveEntrada: z.string().uuid({ message: 'La llave de la entrada debe ser un UUID.' }).optional(),
    checkOutPhotoUrl: foto,
    depositPhotoUrl: foto, // la ficha del depósito, como en la salida de la PAX
    skipReason: z.string().max(500).optional(), // por qué no hay fotos, como en la salida de la PAX
  })
  .refine(b => (b.timeEntryId === undefined) !== (b.llaveEntrada === undefined), {
    message: 'La salida nombra su entrada: manda timeEntryId o llaveEntrada, sólo uno.',
    params: { code: 'SALIDA_SIN_ENTRADA' }, // `validateRequest` responde el 400 con este código
  })

export const entradaDeCampoSchema = z.object({ body: entradaDeCampoBodySchema })
export const salidaDeCampoSchema = z.object({ body: salidaDeCampoBodySchema })

export type EntradaDeCampoBody = z.infer<typeof entradaDeCampoBodySchema>
export type SalidaDeCampoBody = z.infer<typeof salidaDeCampoBodySchema>

/**
 * Custodia del celular: aceptar varias SIMs (tope 50) o rechazar UNA. Cada SIM lleva la `custodyVersion` de la asignación que
 * vio el celular (Codex C3): una decisión vieja no vale para una entrega nueva de la misma SIM.
 */
const simConVersion = z.object({ serialNumber: z.string().min(1), custodyVersion: z.number().int().nonnegative() })
export const aceptarCustodiaSchema = z.object({ body: z.object({ sims: z.array(simConVersion).min(1).max(50) }) })
export const rechazarCustodiaSchema = z.object({ body: simConVersion })
