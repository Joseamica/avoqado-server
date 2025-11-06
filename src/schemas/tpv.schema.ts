import { z } from 'zod'

// Authentication schemas
// NOTE: Allows 4-6 digits for backward compatibility with existing PINs
// SECURITY: 6 digits (1M combinations) is STRONGLY RECOMMENDED over 4 digits (10K combinations)
// TODO: Migrate all existing PINs to 6 digits and enforce .length(6) validation
export const pinLoginSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
  }),
  body: z.object({
    pin: z
      .string()
      .min(4, { message: 'El PIN debe tener al menos 4 dígitos.' })
      .max(6, { message: 'El PIN no puede tener más de 6 dígitos.' })
      .regex(/^\d{4,6}$/, { message: 'El PIN debe contener solo números (4-6 dígitos).' }),
    serialNumber: z
      .string()
      .min(1, { message: 'El número de serie es requerido.' })
      .regex(/^[A-Z0-9-]+$/i, {
        message: 'El número de serie debe contener solo letras, números y guiones.',
      }),
  }),
})

export const refreshTokenSchema = z.object({
  body: z.object({
    refreshToken: z.string().min(1, { message: 'El refresh token es requerido.' }),
  }),
})

export const logoutSchema = z.object({
  body: z.object({
    accessToken: z.string().min(1, { message: 'El access token es requerido.' }),
  }),
})

export const venueIdParamSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
  }),
})

export const serialNumberParamSchema = z.object({
  params: z.object({
    serialNumber: z.string().min(1, { message: 'El número de serie es requerido.' }),
  }),
})

export const orderParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
    orderId: z.string().cuid({ message: 'El ID del order debe ser un CUID válido.' }),
  }),
})

// Payments schemas
export const paymentsQuerySchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
  }),
  query: z.object({
    pageSize: z.string().optional().default('10'),
    pageNumber: z.string().optional().default('1'),
  }),
  body: z
    .object({
      fromDate: z.string().datetime().optional(),
      toDate: z.string().datetime().optional(),
      staffId: z.string().optional(),
    })
    .optional(),
})

// Shifts schemas
export const shiftQuerySchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
  }),
  query: z.object({
    pos_name: z.string().optional(),
  }),
})

export const shiftsQuerySchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
  }),
  query: z.object({
    pageSize: z.string().optional().default('10'),
    pageNumber: z.string().optional().default('1'),
    staffId: z.string().optional(),
    startTime: z.string().datetime().optional(),
    endTime: z.string().datetime().optional(),
  }),
})

export const shiftsSummaryQuerySchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
  }),
  query: z.object({
    staffId: z.string().optional(),
    startTime: z.string().datetime().optional(),
    endTime: z.string().datetime().optional(),
  }),
})

// Payment recording schemas
export const recordPaymentParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
    orderId: z.string().cuid({ message: 'El ID del order debe ser un CUID válido.' }),
  }),
})

export const recordFastPaymentParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
  }),
})

export const recordPaymentBodySchema = z.object({
  body: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
    amount: z.number().int().positive({ message: 'El monto debe ser un número entero positivo (en centavos).' }),
    tip: z.number().int().min(0, { message: 'La propina debe ser un número entero no negativo (en centavos).' }),
    status: z.enum(['COMPLETED', 'PENDING', 'FAILED', 'PROCESSING', 'REFUNDED'], { message: 'Estado de pago inválido.' }),
    method: z.enum(['CASH', 'CREDIT_CARD', 'DEBIT_CARD', 'DIGITAL_WALLET'], { message: 'Método de pago inválido.' }),
    source: z.string().default('TPV'),
    splitType: z.enum(['PERPRODUCT', 'EQUALPARTS', 'CUSTOMAMOUNT', 'FULLPAYMENT'], { message: 'Tipo de división inválido.' }),
    // tpvId: z.string().cuid({ message: 'El ID del TPV debe ser un CUID válido.' }),
    // TEMPORARY FIX: Allow both CUID and numeric string for Android compatibility
    staffId: z.string().refine(
      val => {
        // Allow CUID format
        if (/^c[0-9a-z]{24}$/.test(val)) return true
        // TEMPORARY: Allow numeric strings for Android app compatibility
        if (/^\d+$/.test(val)) return true
        return false
      },
      { message: 'El ID del staff debe ser un CUID válido o un ID numérico temporal.' },
    ),
    paidProductsId: z.array(z.string()).default([]),

    // Card payment fields (optional)
    cardBrand: z.string().optional(),
    last4: z.string().length(4).optional(),
    typeOfCard: z.enum(['CREDIT', 'DEBIT']).optional(),
    currency: z.string().length(3).default('MXN'),
    bank: z.string().optional(),

    // Menta integration fields (optional)
    mentaAuthorizationReference: z.string().optional(),
    mentaOperationId: z.string().optional(),
    mentaTicketId: z.string().optional(),
    token: z.string().optional(),
    isInternational: z.boolean().default(false),

    // Additional fields
    reviewRating: z.string().optional(),

    // Enhanced payment tracking fields (from new database migration)
    authorizationNumber: z.string().optional(),
    referenceNumber: z.string().optional(),
    maskedPan: z.string().optional(),
    entryMode: z.enum(['CONTACTLESS', 'CONTACT', 'CHIP', 'SWIPE', 'MANUAL', 'FALLBACK', 'ONLINE', 'OTHER']).optional(),

    // Split payment specific fields
    equalPartsPartySize: z.number().int().positive().optional(),
    equalPartsPayedFor: z.number().int().positive().optional(),
  }),
})

// Payment routing schemas
export const paymentRouteSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
  }),
  body: z.object({
    amount: z.number().int().positive({ message: 'El monto debe ser un número entero positivo (en centavos).' }),
    merchantAccountId: z.string().cuid({ message: 'El ID de la cuenta merchant debe ser un CUID válido.' }),
    terminalSerial: z.string().min(1, { message: 'El número de serie del terminal es requerido.' }),
    bin: z.string().optional(),
  }),
})
