import { z } from 'zod'

export const supportChallengeSchema = z.object({
  body: z
    .object({
      phone: z.string().trim().min(8, 'Escribe un teléfono con lada.').max(25, 'El teléfono es demasiado largo.'),
      operationKey: z.string().min(8, 'Falta la referencia de esta solicitud.').max(100, 'La referencia es demasiado larga.'),
      personalPhone: z.literal(true, { errorMap: () => ({ message: 'Confirma que este WhatsApp es personal.' }) }),
    })
    .strict(),
})
export const supportVerifySchema = z.object({
  body: z
    .object({
      challengeId: z.string().cuid('La solicitud no es válida.'),
      code: z.string().regex(/^\d{6}$/, 'Escribe el código de seis dígitos.'),
    })
    .strict(),
})
export const supportVenuesSchema = z.object({
  query: z.object({
    cursor: z.string().cuid('La página no es válida.').optional(),
    search: z.string().max(200, 'La búsqueda es demasiado larga.').optional(),
    limit: z.coerce.number().int('El límite debe ser entero.').positive('El límite debe ser positivo.').optional(),
  }),
})
const supportDataLanguage = z.enum(['es', 'en'], { errorMap: () => ({ message: 'El idioma no es válido.' }) })
export const supportDataAccessQuerySchema = z.object({
  query: z.object({
    venueId: z.string().cuid('La sucursal no es válida.'),
    language: supportDataLanguage.optional(),
  }),
})
export const supportDataAccessSchema = z.object({
  body: z
    .object({
      venueId: z.string().cuid('La sucursal no es válida.'),
      noticeHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/, 'El aviso no es válido.')
        .optional(),
      language: supportDataLanguage.optional(),
      // T-B37: true sólo desde «Aceptar» en la ventana del aviso; el toque de todos los días manda false.
      acceptNotice: z.boolean({
        required_error: 'Falta decir si aceptaste el aviso.',
        invalid_type_error: 'La respuesta al aviso no es válida.',
      }),
    })
    .strict(),
})
