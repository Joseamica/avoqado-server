import { z } from 'zod'

/**
 * Fase 0.B — "el body nunca confiere identidad".
 *
 * Zod elimina las claves desconocidas en silencio y `validateRequest` reemplaza `req.body`
 * con el objeto filtrado, así que un `customerId` mandado por el cliente desaparecía antes de
 * que el controller pudiera rechazarlo. Este wrapper inspecciona el input CRUDO (antes del
 * stripping) y, si trae `customerId`, emite un issue con un marcador que `validateRequest`
 * convierte en `400 CUSTOMER_ID_NOT_ALLOWED`.
 *
 * Se aplica sólo a los bodies públicos de reserva y checkout — no es un `.strict()` global:
 * otros campos desconocidos (utm_*, etc.) siguen ignorándose como siempre.
 */
export const CUSTOMER_ID_NOT_ALLOWED = 'CUSTOMER_ID_NOT_ALLOWED' as const

export function rejectBodyCustomerId<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((raw, ctx) => {
    if (raw && typeof raw === 'object' && 'customerId' in (raw as Record<string, unknown>)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['customerId'],
        message: 'No se acepta customerId en el cuerpo de la solicitud.',
        params: { code: CUSTOMER_ID_NOT_ALLOWED },
      })
    }
    return raw
  }, schema)
}
