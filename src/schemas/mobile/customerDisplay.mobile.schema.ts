// src/schemas/mobile/customerDisplay.mobile.schema.ts
import { z } from 'zod'

const conteo = (campo: string) =>
  z
    .number({ required_error: `Falta ${campo}`, invalid_type_error: `${campo} debe ser un número` })
    .int(`${campo} debe ser un entero`)
    .min(0, `${campo} no puede ser negativo`)
    .max(100, `${campo} es demasiado grande`)

const fechaIso = (campo: string) =>
  z
    .string({ required_error: `Falta ${campo}`, invalid_type_error: `${campo} debe ser una fecha ISO` })
    .datetime({ offset: true, message: `${campo} debe ser una fecha ISO` })

/** PUT /mobile/venues/:venueId/customer-display/ack — lo que la tablet DICE mostrar (spec §5.7.2). Sólo forma. */
export const customerDisplayAckSchema = z.object({
  body: z
    .object(
      {
        installationId: z
          .string({ required_error: 'Falta la instalación', invalid_type_error: 'La instalación debe ser texto' })
          .min(1, 'La instalación no puede ir vacía')
          .max(64, 'La instalación es demasiado larga')
          .regex(/^[A-Za-z0-9-]+$/, 'La instalación sólo admite letras, números y guiones'),
        fingerprint: z
          .string({ required_error: 'Falta la huella', invalid_type_error: 'La huella debe ser texto' })
          .regex(/^[0-9a-f]{32}$/, 'La huella no tiene el formato esperado'),
        seq: z
          .number({ required_error: 'Falta la secuencia', invalid_type_error: 'La secuencia debe ser un número' })
          .int('La secuencia debe ser un entero')
          .min(0, 'La secuencia no puede ser negativa')
          .max(Number.MAX_SAFE_INTEGER, 'La secuencia es demasiado grande'),
        storedAt: fechaIso('storedAt'),
        // «Vacío» = omitido O null (encodeDefaults false o true): el omitido se normaliza a null AQUÍ, antes de `armarAcuse`
        // (un `shownAt` undefined que llegara al servicio se leería «mostrado»). El servicio nunca ve undefined.
        shownAt: fechaIso('shownAt').nullable().default(null),
        // R1: `window` es la ventana del cliente del POS de Windows; sin ella su ack sería 400 para siempre.
        surface: z
          .enum(['presentation', 'activity', 'kiosk', 'window'], { errorMap: () => ({ message: 'La superficie no es válida' }) })
          .nullable()
          .default(null),
        imagesReady: conteo('imagesReady'),
        imagesPending: conteo('imagesPending'),
        imagesFailed: conteo('imagesFailed'),
        unsupportedSchema: z.boolean({
          required_error: 'Falta unsupportedSchema',
          invalid_type_error: 'unsupportedSchema debe ser verdadero o falso',
        }),
      },
      {
        // Sólo `errorMap` (combinado con `invalid_type_error`, Zod truena al cargar el módulo). Cubre lo del OBJETO: un cuerpo
        // que no es objeto y la llave desconocida que rechaza `.strict()`, nombrándola para quien depura la tablet.
        errorMap: issue => ({
          message:
            issue.code === 'unrecognized_keys'
              ? `El acuse trae campos que el servidor no conoce: ${issue.keys.join(', ')}`
              : 'El acuse debe ser un objeto',
        }),
      },
    )
    .strict(),
  params: z.object({ venueId: z.string().min(1, 'El venue es requerido') }).passthrough(),
})
