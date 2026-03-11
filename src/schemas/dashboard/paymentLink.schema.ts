import { z } from 'zod'

// ═══════════════════════════════════════════════════════════════════════════
// BODY SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

export const createPaymentLinkBodySchema = z
  .object({
    title: z.string().min(1, 'El título es requerido').max(100, 'El título no puede exceder 100 caracteres'),
    description: z.string().max(400, 'La descripción no puede exceder 400 caracteres').optional(),
    imageUrl: z.string().url('URL de imagen inválida').optional(),
    amountType: z.enum(['FIXED', 'OPEN'], {
      required_error: 'El tipo de monto es requerido',
      invalid_type_error: 'El tipo de monto debe ser FIXED u OPEN',
    }),
    amount: z.number().positive('El monto debe ser mayor a 0').optional(),
    currency: z.string().default('MXN'),
    isReusable: z.boolean().default(false),
    expiresAt: z.string().datetime('Fecha de expiración inválida').optional(),
    redirectUrl: z.string().url('URL de redirección inválida').optional(),
  })
  .refine(
    data => {
      if (data.amountType === 'FIXED' && (data.amount === undefined || data.amount === null)) {
        return false
      }
      return true
    },
    {
      message: 'El monto es requerido para ligas de pago con monto fijo',
      path: ['amount'],
    },
  )

export const updatePaymentLinkBodySchema = z.object({
  title: z.string().min(1, 'El título es requerido').max(100, 'El título no puede exceder 100 caracteres').optional(),
  description: z.string().max(400, 'La descripción no puede exceder 400 caracteres').optional().nullable(),
  imageUrl: z.string().url('URL de imagen inválida').optional().nullable(),
  amountType: z.enum(['FIXED', 'OPEN']).optional(),
  amount: z.number().positive('El monto debe ser mayor a 0').optional().nullable(),
  currency: z.string().optional(),
  isReusable: z.boolean().optional(),
  expiresAt: z.string().datetime('Fecha de expiración inválida').optional().nullable(),
  redirectUrl: z.string().url('URL de redirección inválida').optional().nullable(),
  status: z.enum(['ACTIVE', 'PAUSED']).optional(),
})

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC CHECKOUT SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

export const checkoutBodySchema = z.object({
  pan: z.string().min(13, 'Número de tarjeta inválido').max(19, 'Número de tarjeta inválido'),
  cvv: z.string().min(3, 'CVV inválido').max(4, 'CVV inválido'),
  expMonth: z.string().length(2, 'Mes de expiración inválido'),
  expYear: z.string().length(4, 'Año de expiración inválido'),
  holderName: z.string().min(1, 'El nombre del titular es requerido'),
  customerEmail: z.string().email('Email inválido').optional(),
  customerPhone: z.string().optional(),
  amount: z.number().positive('El monto debe ser mayor a 0').optional(), // Required for OPEN amount links
})

export const chargeBodySchema = z.object({
  sessionId: z.string().min(1, 'El ID de sesión es requerido'),
  threeDSTransactionId: z.string().optional(),
})

// ═══════════════════════════════════════════════════════════════════════════
// COMBINED SCHEMAS (for validateRequest middleware)
// ═══════════════════════════════════════════════════════════════════════════

export const createPaymentLinkSchema = z.object({
  params: z.object({
    venueId: z.string().min(1, 'Venue ID es requerido'),
  }),
  body: createPaymentLinkBodySchema,
})

export const updatePaymentLinkSchema = z.object({
  params: z.object({
    venueId: z.string().min(1),
    linkId: z.string().min(1),
  }),
  body: updatePaymentLinkBodySchema,
})

export const getPaymentLinkSchema = z.object({
  params: z.object({
    venueId: z.string().min(1),
    linkId: z.string().min(1),
  }),
})

export const listPaymentLinksSchema = z.object({
  params: z.object({
    venueId: z.string().min(1),
  }),
  query: z.object({
    status: z.enum(['ACTIVE', 'PAUSED', 'EXPIRED', 'ARCHIVED']).optional(),
    search: z.string().optional(),
    limit: z.string().transform(Number).optional(),
    offset: z.string().transform(Number).optional(),
  }),
})

export const publicShortCodeSchema = z.object({
  params: z.object({
    shortCode: z.string().min(1, 'Código de liga inválido'),
  }),
})

export const publicCheckoutSchema = z.object({
  params: z.object({
    shortCode: z.string().min(1),
  }),
  body: checkoutBodySchema,
})

export const publicChargeSchema = z.object({
  params: z.object({
    shortCode: z.string().min(1),
  }),
  body: chargeBodySchema,
})

export const publicSessionSchema = z.object({
  params: z.object({
    shortCode: z.string().min(1),
    sessionId: z.string().min(1),
  }),
})
