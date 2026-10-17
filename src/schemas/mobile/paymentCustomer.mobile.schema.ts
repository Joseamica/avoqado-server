import { z } from 'zod'

/**
 * «Agregar cliente» en «Cobro exitoso» del POS (Android/iOS): sólo la FORMA del body.
 *
 * 🔴 BAJO-2 (full-testing, 15-oct-2026): `{"customerId": 12345}` respondía 500 («customerId?.trim is not a function»):
 * ninguna de las dos rutas validaba el body y el número llegaba al servicio. Las reglas de negocio (el pago existe, es de
 * este negocio, el monto es positivo) siguen en el servicio.
 *
 * 🔴 `validateRequest` QUITA los campos que el schema no nombra: aquí van TODOS los que leen los controllers
 * (`payment.mobile.controller.ts`). Sin `params` a propósito: validarlos reescribiría `req.params` y se perdería el `paymentId`.
 */
// M3 (ronda 1): `validateRequest` ya antepone el campo («customerId: …»); el mensaje dice una sola vez qué falta.
const customerId = z.string({ required_error: 'es requerido', invalid_type_error: 'debe ser un texto' }).trim().min(1, 'es requerido')

const cuerpo = {
  required_error: 'El cuerpo de la solicitud es requerido',
  invalid_type_error: 'El cuerpo de la solicitud debe ser un objeto',
}

/** POST /mobile/venues/:venueId/payments/:paymentId/customer */
export const attachCustomerToPaymentSchema = z.object({
  body: z.object({ customerId }, cuerpo),
})

/**
 * POST /mobile/venues/:venueId/payments/customer — el pago se busca por monto, propina y quien cobró (últimos 15 min).
 * `staffId` = quien COBRÓ (filtra el pago); el actor de la liga sale del token.
 */
export const attachCustomerToLatestPaymentSchema = z.object({
  body: z.object(
    {
      customerId,
      amountCents: z.number({ required_error: 'es requerido', invalid_type_error: 'debe ser un número' }),
      tipCents: z.number({ invalid_type_error: 'debe ser un número' }).nullish(),
      staffId: z.string({ invalid_type_error: 'debe ser un texto' }).nullish(),
    },
    cuerpo,
  ),
})
