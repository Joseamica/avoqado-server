import { z } from 'zod'

// ═══════════════════════════════════════════════════════════════════════════
// CUSTOM FIELD & TIPPING SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

const customFieldSchema = z.object({
  id: z.string().min(1, 'ID del campo es requerido'),
  type: z.enum(['TEXT', 'SELECT'], { invalid_type_error: 'El tipo de campo debe ser TEXT o SELECT' }),
  label: z.string().min(1, 'La etiqueta del campo es requerida').max(100, 'La etiqueta no puede exceder 100 caracteres'),
  required: z.boolean().default(false),
  options: z.array(z.string().min(1, 'Cada opción debe tener al menos un carácter')).optional(),
})

const customFieldsSchema = z.array(customFieldSchema).max(5, 'Máximo 5 campos personalizados').optional().nullable()

const tippingConfigSchema = z
  .object({
    presets: z
      .array(z.number().min(1, 'El porcentaje debe ser mayor a 0').max(100, 'El porcentaje no puede exceder 100'))
      .min(1, 'Se requiere al menos un porcentaje')
      .max(4, 'Máximo 4 opciones de porcentaje'),
    allowCustom: z.boolean().default(true),
  })
  .optional()
  .nullable()

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
    purpose: z.enum(['PAYMENT', 'ITEM', 'DONATION']).default('PAYMENT'),
    /** Bundle line items — required for ITEM purpose, ignored otherwise.
     *  Each item may include pre-selected modifiers (size, toppings, etc.).
     *  Service-layer validation enforces required/min/max selection rules. */
    items: z
      .array(
        z.object({
          productId: z.string().min(1, 'ID de producto inválido'),
          quantity: z.number().int().min(1, 'La cantidad debe ser al menos 1').max(999, 'Cantidad demasiado grande'),
          modifiers: z
            .array(
              z.object({
                modifierId: z.string().min(1, 'ID de modificador inválido'),
                quantity: z.number().int().min(1).max(99).optional(),
              }),
            )
            .max(20, 'Máximo 20 modificadores por producto')
            .optional(),
        }),
      )
      .max(20, 'Máximo 20 productos por liga de pago')
      .optional(),
    // Optional channel pinning — when omitted the service auto-picks (Blumon
    // first, then any active merchant). Required to disambiguate when the
    // venue has multiple active ecommerce merchants (e.g. Stripe + Blumon).
    ecommerceMerchantId: z.string().min(1).optional(),
    // Optional commission attribution — array of staff IDs who earn
    // commission for sales via this link. Empty/omitted → no commission.
    // With N IDs → commission split equally across all N staff. See
    // finalizePaymentLinkCheckout + createSplitCommissionForPayment.
    attributedStaffIds: z.array(z.string().min(1)).max(10, 'Máximo 10 personas atribuidas').optional(),
    customFields: customFieldsSchema,
    tippingConfig: tippingConfigSchema,
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
  .refine(
    data => {
      if (data.purpose === 'ITEM' && (!data.items || data.items.length === 0)) {
        return false
      }
      return true
    },
    {
      message: 'Se requiere al menos un producto para ligas de pago de artículo',
      path: ['items'],
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
  items: z
    .array(
      z.object({
        productId: z.string().min(1, 'ID de producto inválido'),
        quantity: z.number().int().min(1, 'La cantidad debe ser al menos 1').max(999, 'Cantidad demasiado grande'),
        modifiers: z
          .array(
            z.object({
              modifierId: z.string().min(1, 'ID de modificador inválido'),
              quantity: z.number().int().min(1).max(99).optional(),
            }),
          )
          .max(20, 'Máximo 20 modificadores por producto')
          .optional(),
      }),
    )
    .max(20, 'Máximo 20 productos por liga de pago')
    .optional()
    .nullable(),
  customFields: customFieldsSchema,
  tippingConfig: tippingConfigSchema,
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
  quantity: z.number().int().min(1).default(1), // For ITEM payment links
  tipAmount: z.number().min(0, 'La propina no puede ser negativa').optional(),
  customFieldResponses: z.record(z.string(), z.string()).optional(), // { fieldId: value }
})

export const chargeBodySchema = z.object({
  sessionId: z.string().min(1, 'El ID de sesión es requerido'),
  threeDSTransactionId: z.string().optional(),
})

// ═══════════════════════════════════════════════════════════════════════════
// BRANDING SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Per-venue branding for the public payment-link checkout. All fields
 * optional — the service merges with sane defaults. `buttonColor` must be
 * a 7-char hex (#RRGGBB) so it can flow safely into inline `style` props
 * on pay.avoqado.io without XSS risk.
 */
export const paymentLinkBrandingBodySchema = z.object({
  showLogo: z.boolean().optional(),
  buttonColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'El color debe ser un código HEX de 6 dígitos (ej. #006aff)')
    .optional(),
  buttonShape: z.enum(['rounded', 'square', 'pill']).optional(),
  showImage: z.boolean().optional(),
  showTitle: z.boolean().optional(),
  showPrice: z.boolean().optional(),
})

export const updatePaymentLinkBrandingSchema = z.object({
  params: z.object({
    venueId: z.string().min(1, 'Venue ID es requerido'),
  }),
  body: paymentLinkBrandingBodySchema,
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

/**
 * Body schema for `POST /payment-links/:shortCode/stripe-checkout`.
 *
 * All fields optional — Stripe collects card data itself. Customer email +
 * custom fields are forwarded into Stripe metadata for the receipt + our
 * webhook handler.
 */
export const publicStripeCheckoutSchema = z.object({
  params: z.object({
    shortCode: z.string().min(1),
  }),
  body: z.object({
    amount: z.number().positive().optional(),
    quantity: z.number().int().positive().optional(),
    tipAmount: z.number().nonnegative().optional(),
    customerEmail: z.string().email('Email inválido').optional(),
    customFieldResponses: z.record(z.string()).optional(),
    returnUrl: z.string().url('URL de retorno inválida').optional(),
  }),
})

/**
 * Body schema for `POST /payment-links/:shortCode/payment-intent` (Stripe
 * Elements / inline flow). Same body as the checkout variant minus the
 * returnUrl — the Elements flow stays on our domain, no redirect needed.
 */
export const publicStripePaymentIntentSchema = z.object({
  params: z.object({
    shortCode: z.string().min(1),
  }),
  body: z.object({
    amount: z.number().positive().optional(),
    quantity: z.number().int().positive().optional(),
    tipAmount: z.number().nonnegative().optional(),
    customerEmail: z.string().email('Email inválido').optional(),
    customFieldResponses: z.record(z.string()).optional(),
  }),
})
