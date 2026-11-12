import { z } from 'zod'
import { PIN_REGEX } from '../common/pin.schema'

/**
 * PIN de autorización de gerente. El PIN viaja UNA vez por request, sobre TLS,
 * y nunca se guarda en el dispositivo.
 */
export const createPermissionOverrideSchema = z.object({
  params: z.object({
    venueId: z.string().min(1, { message: 'El ID del establecimiento es requerido.' }),
  }),
  body: z.object({
    // 4-10 dígitos: el mismo rango que tpv.schema.ts, invitation.schema.ts y el
    // alta por superadmin. Un rango distinto aquí rechazaría PINs válidos.
    pin: z.string().regex(PIN_REGEX, { message: 'El código debe tener entre 4 y 10 dígitos.' }),
    permission: z
      .string()
      .min(3, { message: 'El permiso es requerido.' })
      .regex(/^[a-z0-9-]+:[a-z0-9_-]+$/i, { message: 'Formato de permiso inválido.' }),
    // Ata la autorización a UNA operación: un retiro de caja ("pay-out:<localId>:<centavos>") o el descuento de un cliente
    // ("descuento-cliente:<customerId>:<discountId>", cada id con la forma de `.cuid()` de Zod, la misma que acepta la venta).
    // `validateRequest` reemplaza el cuerpo por lo validado: sin este campo la llave se perdía antes de llegar al controlador.
    operationKey: z
      .string()
      .min(1)
      .max(200)
      .regex(/^(pay-out:[^:\s]{1,64}:\d{1,12}|descuento-cliente:c[^\s:-]{8,}:c[^\s:-]{8,})$/, {
        message: 'Formato de operación inválido.',
      })
      .optional(),
  }),
})
