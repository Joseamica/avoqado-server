// src/schemas/mobile/customerDisplay.mobile.schema.ts
import { z } from 'zod'

const conteo = (campo: string) =>
  z
    .number({ required_error: `Falta ${campo}`, invalid_type_error: `${campo} debe ser un número` })
    .int(`${campo} debe ser un entero`)
    .min(0, `${campo} no puede ser negativo`)
    .max(100, `${campo} es demasiado grande`)

const fechaIso = (campo: string) =>
  z.string({ required_error: `Falta ${campo}` }).datetime({ offset: true, message: `${campo} debe ser una fecha ISO` })

/** PUT /mobile/venues/:venueId/customer-display/ack — lo que la tablet DICE mostrar (spec §5.7.2). Sólo forma. */
export const customerDisplayAckSchema = z.object({
  body: z
    .object({
      installationId: z
        .string({ required_error: 'Falta la instalación' })
        .min(1, 'La instalación no puede ir vacía')
        .max(64, 'La instalación es demasiado larga')
        .regex(/^[A-Za-z0-9-]+$/, 'La instalación sólo admite letras, números y guiones'),
      fingerprint: z.string({ required_error: 'Falta la huella' }).regex(/^[0-9a-f]{32}$/, 'La huella no tiene el formato esperado'),
      seq: z
        .number({ required_error: 'Falta la secuencia', invalid_type_error: 'La secuencia debe ser un número' })
        .int('La secuencia debe ser un entero')
        .min(0, 'La secuencia no puede ser negativa')
        .max(Number.MAX_SAFE_INTEGER, 'La secuencia es demasiado grande'),
      storedAt: fechaIso('storedAt'),
      shownAt: fechaIso('shownAt').nullable(),
      // R1: `window` es la ventana del cliente del POS de Windows; sin ella su ack sería 400 para siempre.
      surface: z
        .enum(['presentation', 'activity', 'kiosk', 'window'], { errorMap: () => ({ message: 'La superficie no es válida' }) })
        .nullable(),
      imagesReady: conteo('imagesReady'),
      imagesPending: conteo('imagesPending'),
      imagesFailed: conteo('imagesFailed'),
      unsupportedSchema: z.boolean({ required_error: 'Falta unsupportedSchema' }),
    })
    .strict(),
  params: z.object({ venueId: z.string().min(1, 'El venue es requerido') }).passthrough(),
})
