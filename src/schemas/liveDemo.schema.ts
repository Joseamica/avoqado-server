/**
 * Live Demo Schemas
 *
 * Validation for public live-demo endpoints (demo.dashboard.avoqado.io).
 * IMPORTANT: All messages in Spanish — validation errors are shown raw to users.
 */

import { z } from 'zod'

/** Max base amount per simulated payment: 5,000,000 cents ($50,000.00 MXN) */
export const SIM_PAYMENT_MAX_AMOUNT_CENTS = 5_000_000

/** Max tip per simulated payment: 1,000,000 cents ($10,000.00 MXN) */
export const SIM_PAYMENT_MAX_TIP_CENTS = 1_000_000

// POST /api/v1/live-demo/sim/fast-payment
export const simFastPaymentBodySchema = z.object({
  body: z.object({
    amountCents: z
      .number({
        required_error: 'El monto (amountCents) es requerido.',
        invalid_type_error: 'El monto (amountCents) debe ser un número.',
      })
      .int({ message: 'El monto (amountCents) debe ser un número entero de centavos.' })
      .positive({ message: 'El monto (amountCents) debe ser mayor a 0.' })
      .max(SIM_PAYMENT_MAX_AMOUNT_CENTS, {
        message: `El monto (amountCents) no puede exceder ${SIM_PAYMENT_MAX_AMOUNT_CENTS} centavos.`,
      }),
    tipCents: z
      .number({ invalid_type_error: 'La propina (tipCents) debe ser un número.' })
      .int({ message: 'La propina (tipCents) debe ser un número entero de centavos.' })
      .min(0, { message: 'La propina (tipCents) no puede ser negativa.' })
      .max(SIM_PAYMENT_MAX_TIP_CENTS, {
        message: `La propina (tipCents) no puede exceder ${SIM_PAYMENT_MAX_TIP_CENTS} centavos.`,
      })
      .optional(),
  }),
})
