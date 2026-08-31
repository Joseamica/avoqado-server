import { z } from 'zod'
import { PIN_REGEX } from '../common/pin.schema'

/**
 * Cambiar de usuario por PIN en el POS móvil.
 *
 * El PIN viaja UNA vez por request, sobre TLS, y NUNCA se guarda en el aparato: guardarlo para
 * validarlo en local convertiría 4 dígitos en algo que se rompe probando 10,000 veces sin red.
 */
export const switchUserSchema = z.object({
  params: z.object({
    venueId: z.string().min(1, { message: 'El ID del establecimiento es requerido.' }),
  }),
  body: z.object({
    // 4-10 dígitos: el MISMO rango que el resto de la casa (tpv, invitación, alta por superadmin).
    // Un rango distinto aquí rechazaría PINs que ya existen y funcionan en la PAX.
    pin: z.string().regex(PIN_REGEX, { message: 'El PIN debe tener entre 4 y 10 dígitos.' }),
  }),
})
