import { z } from 'zod'

// IMPORTANT: Zod messages must be in Spanish — they surface raw to users
// via the validation middleware (see avoqado-server CLAUDE.md / MEMORY).
// The middleware (`validateRequest`) expects a top-level z.object with
// `body` / `query` / `params` keys.

export const createTerminalOrderSchema = z.object({
  body: z.object({
    items: z
      .array(
        z.object({
          catalogKey: z.string().min(1, 'El modelo es obligatorio'),
          quantity: z.number().int().min(1, 'Mínimo 1 unidad').max(10, 'Máximo 10 unidades por modelo'),
          namePrefix: z.string().optional(),
        }),
      )
      .min(1, 'Debes elegir al menos un modelo')
      .max(5, 'Máximo 5 modelos distintos por pedido'),
    contactName: z.string().min(1, 'El nombre del contacto es obligatorio'),
    contactEmail: z.string().email('Correo electrónico inválido'),
    contactPhone: z.string().min(1, 'El teléfono es obligatorio'),
    shippingAddress: z.string().min(1, 'La dirección es obligatoria'),
    shippingAddress2: z.string().optional(),
    shippingCity: z.string().min(1, 'La ciudad es obligatoria'),
    shippingState: z.string().min(1, 'El estado es obligatorio'),
    shippingZip: z.string().min(1, 'El código postal es obligatorio'),
    shippingCountry: z.string().optional(),
    paymentMethod: z.enum(['CARD_STRIPE', 'SPEI']),
    // Where the purchase wizard was opened from. Affects Stripe success/cancel
    // URLs (lands at /setup#step-8 when 'setup'). Optional, defaults to 'tpv'
    // in the controller. Spec: 2026-05-29-onboarding-tpv-purchase-design.md.
    from: z.enum(['tpv', 'setup']).optional(),
  }),
})

export type CreateTerminalOrderBody = z.infer<typeof createTerminalOrderSchema.shape.body>
