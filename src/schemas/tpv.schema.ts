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
  body: z
    .object({
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

      // ⭐ Provider-agnostic merchant account tracking (2025-01-11)
      // Allows TPV to specify which merchant account should process the payment
      // ✅ CONDITIONAL VALIDATION: Required for card payments, null for cash
      merchantAccountId: z.string().cuid({ message: 'El ID de la cuenta merchant debe ser un CUID válido.' }).nullable().optional(),
      // Blumon serial number format: 10-digit numeric string (e.g., "2841548417")
      // Used for TIER 2 merchant recovery when merchantAccountId is invalid/missing
      blumonSerialNumber: z
        .string()
        .regex(/^[0-9]{10}$/, { message: 'El serial Blumon debe ser un número de 10 dígitos' })
        .optional(),

      // Split payment specific fields
      equalPartsPartySize: z.number().int().positive().optional(),
      equalPartsPayedFor: z.number().int().positive().optional(),

      // 🔧 PRE-payment verification fields (generated ONCE when entering verification screen)
      // orderReference is used to:
      // 1. Name Firebase Storage photos (e.g., "FAST-1765549860972_1.jpg")
      // 2. Set Order.orderNumber in backend (ensures photos match order)
      // For fast payments: "FAST-{timestamp}" (generated by Android when entering VerifyingPrePayment)
      // For order payments: Uses existing order number (e.g., "ORD-12345")
      orderReference: z
        .string()
        .regex(/^(FAST|ORD|ORDER)-\d+$/, { message: 'orderReference must be FAST-{timestamp} or ORD-{number} format' })
        .optional(),

      // Firebase Storage URLs of verification photos (uploaded before payment)
      verificationPhotos: z.array(z.string().url({ message: 'Each photo must be a valid URL' })).optional(),

      // Scanned barcodes from verification screen
      verificationBarcodes: z.array(z.string()).optional(),
    })
    .refine(
      data => {
        // ✅ Business rule: Card payments need merchantAccountId OR blumonSerialNumber (for TIER 2 recovery)
        // TIER 1: merchantAccountId provided directly
        // TIER 2: blumonSerialNumber allows backend to infer merchantAccountId (SOURCE OF TRUTH)
        if (['CREDIT_CARD', 'DEBIT_CARD', 'DIGITAL_WALLET'].includes(data.method)) {
          const hasMerchantId = data.merchantAccountId != null && data.merchantAccountId !== ''
          const hasBlumonSerial = data.blumonSerialNumber != null && data.blumonSerialNumber !== ''
          return hasMerchantId || hasBlumonSerial // Either one allows TIER 1 or TIER 2 resolution
        }
        // ✅ Business rule: Cash payments SHOULD NOT have merchantAccountId (null = correct separation for reconciliation)
        if (data.method === 'CASH') {
          return data.merchantAccountId == null || data.merchantAccountId === ''
        }
        return true
      },
      {
        message:
          'Card payments require merchantAccountId OR blumonSerialNumber for merchant resolution. Cash payments should not have merchantAccountId.',
        path: ['merchantAccountId'],
      },
    ),
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

// Table management schemas
export const tableParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
  }),
})

export const assignTableSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
  }),
  body: z.object({
    tableId: z.string().cuid({ message: 'El ID de la mesa debe ser un CUID válido.' }),
    staffId: z.string().cuid({ message: 'El ID del staff debe ser un CUID válido.' }),
    covers: z.number().int().positive({ message: 'El número de comensales debe ser un entero positivo.' }),
  }),
})

export const clearTableSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
    tableId: z.string().cuid({ message: 'El ID de la mesa debe ser un CUID válido.' }),
  }),
})

// Order item management schemas
export const addOrderItemsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
    orderId: z.string().cuid({ message: 'El ID del pedido debe ser un CUID válido.' }),
  }),
  body: z.object({
    items: z
      .array(
        z.object({
          productId: z.string().cuid({ message: 'El ID del producto debe ser un CUID válido.' }),
          quantity: z.number().int().positive({ message: 'La cantidad debe ser un entero positivo.' }),
          notes: z.string().optional().nullable(),
          modifierIds: z.array(z.string().cuid()).optional(), // ✅ FIX: Allow modifier IDs to be sent from Android
        }),
      )
      .min(1, { message: 'Debe proporcionar al menos un ítem.' }),
    version: z.number().int().nonnegative({ message: 'La versión debe ser un entero no negativo.' }),
  }),
})

export const removeOrderItemSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
    orderId: z.string().cuid({ message: 'El ID del pedido debe ser un CUID válido.' }),
    itemId: z.string().cuid({ message: 'El ID del ítem debe ser un CUID válido.' }),
  }),
  query: z.object({
    version: z.string().regex(/^\d+$/, { message: 'La versión debe ser un número entero.' }).transform(Number),
  }),
})

// Guest information management schemas
export const updateGuestInfoSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
    orderId: z.string().cuid({ message: 'El ID del pedido debe ser un CUID válido.' }),
  }),
  body: z.object({
    covers: z.number().int().positive({ message: 'El número de comensales debe ser un entero positivo.' }).optional(),
    customerName: z.string().min(1, { message: 'El nombre del cliente no puede estar vacío.' }).optional().nullable(),
    customerPhone: z
      .string()
      .regex(/^[0-9+\-() ]+$/, { message: 'El teléfono debe contener solo números y símbolos válidos.' })
      .optional()
      .nullable(),
    specialRequests: z.string().optional().nullable(),
    customerId: z.string().cuid({ message: 'El ID del cliente debe ser un CUID válido.' }).optional().nullable(),
  }),
})

// Order-Customer relationship schemas (multi-customer support)
export const addOrderCustomerSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
    orderId: z.string().cuid({ message: 'El ID del pedido debe ser un CUID válido.' }),
  }),
  body: z.object({
    customerId: z.string().cuid({ message: 'El ID del cliente debe ser un CUID válido.' }),
  }),
})

export const removeOrderCustomerSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
    orderId: z.string().cuid({ message: 'El ID del pedido debe ser un CUID válido.' }),
    customerId: z.string().cuid({ message: 'El ID del cliente debe ser un CUID válido.' }),
  }),
})

export const createAndAddCustomerSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
    orderId: z.string().cuid({ message: 'El ID del pedido debe ser un CUID válido.' }),
  }),
  body: z
    .object({
      firstName: z.string().min(1, { message: 'El nombre no puede estar vacío.' }).optional(),
      phone: z
        .string()
        .regex(/^[0-9+\-() ]+$/, { message: 'El teléfono debe contener solo números y símbolos válidos.' })
        .optional(),
      email: z.string().email({ message: 'El email debe ser válido.' }).optional(),
    })
    .refine(data => data.firstName || data.phone || data.email, {
      message: 'Se requiere al menos nombre, teléfono o email.',
    }),
})

// Order action schemas (comp, void, discount)
export const compItemsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
    orderId: z.string().cuid({ message: 'El ID del pedido debe ser un CUID válido.' }),
  }),
  body: z.object({
    itemIds: z
      .array(z.string().cuid({ message: 'Los IDs de ítems deben ser CUIDs válidos.' }))
      .default([])
      .describe('Array vacío = comp entire order'),
    reason: z.string().min(1, { message: 'La razón es requerida.' }),
    staffId: z.string().cuid({ message: 'El ID del staff debe ser un CUID válido.' }),
    notes: z.string().optional(),
  }),
})

export const voidItemsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
    orderId: z.string().cuid({ message: 'El ID del pedido debe ser un CUID válido.' }),
  }),
  body: z.object({
    itemIds: z
      .array(z.string().cuid({ message: 'Los IDs de ítems deben ser CUIDs válidos.' }))
      .min(1, { message: 'Debe proporcionar al menos un ítem para anular.' }),
    reason: z.string().min(1, { message: 'La razón es requerida.' }),
    staffId: z.string().cuid({ message: 'El ID del staff debe ser un CUID válido.' }),
    expectedVersion: z.number().int().nonnegative({ message: 'La versión debe ser un entero no negativo.' }),
  }),
})

export const applyDiscountSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
    orderId: z.string().cuid({ message: 'El ID del pedido debe ser un CUID válido.' }),
  }),
  body: z
    .object({
      type: z.enum(['PERCENTAGE', 'FIXED_AMOUNT'], { message: 'Tipo de descuento inválido.' }),
      value: z.number().positive({ message: 'El valor debe ser un número positivo.' }),
      reason: z.string().optional(),
      staffId: z.string().cuid({ message: 'El ID del staff debe ser un CUID válido.' }),
      itemIds: z
        .array(z.string().cuid({ message: 'Los IDs de ítems deben ser CUIDs válidos.' }))
        .optional()
        .nullable(),
      expectedVersion: z.number().int().nonnegative({ message: 'La versión debe ser un entero no negativo.' }),
    })
    .refine(
      data => {
        // Validate percentage is between 0-100
        if (data.type === 'PERCENTAGE') {
          return data.value > 0 && data.value <= 100
        }
        return true
      },
      {
        message: 'El porcentaje de descuento debe estar entre 1 y 100.',
        path: ['value'],
      },
    ),
})

// ==========================================
// TPV DISCOUNT SYSTEM SCHEMAS (Phase 2)
// ==========================================

export const getAvailableDiscountsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
    orderId: z.string().cuid({ message: 'El ID del pedido debe ser un CUID válido.' }),
  }),
  query: z.object({
    customerId: z.string().cuid({ message: 'El ID del cliente debe ser un CUID válido.' }).optional(),
  }),
})

export const applyAutomaticDiscountsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
    orderId: z.string().cuid({ message: 'El ID del pedido debe ser un CUID válido.' }),
  }),
})

export const applyPredefinedDiscountSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
    orderId: z.string().cuid({ message: 'El ID del pedido debe ser un CUID válido.' }),
  }),
  body: z.object({
    discountId: z.string().cuid({ message: 'El ID del descuento debe ser un CUID válido.' }),
    authorizedById: z.string().cuid({ message: 'El ID del autorizador debe ser un CUID válido.' }).optional(),
  }),
})

export const applyManualDiscountSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
    orderId: z.string().cuid({ message: 'El ID del pedido debe ser un CUID válido.' }),
  }),
  body: z
    .object({
      type: z.enum(['PERCENTAGE', 'FIXED_AMOUNT', 'COMP'], { message: 'Tipo de descuento inválido.' }),
      value: z.number().nonnegative({ message: 'El valor debe ser un número no negativo.' }),
      reason: z.string().min(1, { message: 'La razón del descuento es requerida.' }),
      authorizedById: z.string().cuid({ message: 'El ID del autorizador debe ser un CUID válido.' }).optional(),
    })
    .refine(
      data => {
        if (data.type === 'PERCENTAGE') {
          return data.value > 0 && data.value <= 100
        }
        return true
      },
      {
        message: 'El porcentaje de descuento debe estar entre 1 y 100.',
        path: ['value'],
      },
    )
    .refine(
      data => {
        // COMP requires authorization
        if (data.type === 'COMP' && !data.authorizedById) {
          return false
        }
        return true
      },
      {
        message: 'Los descuentos tipo COMP requieren autorización de un manager.',
        path: ['authorizedById'],
      },
    ),
})

export const applyCouponCodeSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
    orderId: z.string().cuid({ message: 'El ID del pedido debe ser un CUID válido.' }),
  }),
  body: z.object({
    couponCode: z
      .string()
      .min(3, { message: 'El código del cupón debe tener al menos 3 caracteres.' })
      .max(30, { message: 'El código del cupón no puede tener más de 30 caracteres.' }),
  }),
})

export const validateCouponSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
  }),
  body: z.object({
    couponCode: z
      .string()
      .min(3, { message: 'El código del cupón debe tener al menos 3 caracteres.' })
      .max(30, { message: 'El código del cupón no puede tener más de 30 caracteres.' }),
    orderTotal: z.number().nonnegative({ message: 'El total del pedido debe ser un número no negativo.' }),
    customerId: z.string().cuid({ message: 'El ID del cliente debe ser un CUID válido.' }).optional(),
  }),
})

export const removeOrderDiscountSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
    orderId: z.string().cuid({ message: 'El ID del pedido debe ser un CUID válido.' }),
    discountId: z.string().cuid({ message: 'El ID del descuento debe ser un CUID válido.' }),
  }),
})

export const getOrderDiscountsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
    orderId: z.string().cuid({ message: 'El ID del pedido debe ser un CUID válido.' }),
  }),
})

// ============================================================
// 📸 Step 4: Sale Verification Schemas
// ============================================================
// Used by retail/telecommunications venues to capture evidence
// of sales (photos + barcodes) for audit and inventory deduction

/** Schema for scanned product in verification */
const scannedProductSchema = z.object({
  barcode: z.string().min(1, { message: 'El código de barras es requerido.' }),
  format: z.string().default('UNKNOWN'),
  productName: z.string().optional().nullable(),
  productId: z.string().cuid().optional().nullable(),
  hasInventory: z.boolean().default(false),
  quantity: z.number().int().positive().default(1),
})

/** Schema for creating a sale verification */
export const createSaleVerificationSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
  }),
  body: z.object({
    paymentId: z.string().cuid({ message: 'El ID del pago debe ser un CUID válido.' }),
    staffId: z.string().cuid({ message: 'El ID del staff debe ser un CUID válido.' }),
    photos: z.array(z.string().url({ message: 'Cada foto debe ser una URL válida.' })).default([]),
    scannedProducts: z.array(scannedProductSchema).default([]),
    deviceId: z.string().optional().nullable(),
    notes: z.string().optional().nullable(),
    status: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'SKIPPED']).default('PENDING'),
  }),
})

/** Schema for listing sale verifications */
export const listSaleVerificationsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
  }),
  query: z.object({
    pageSize: z.string().optional().default('20'),
    pageNumber: z.string().optional().default('1'),
    status: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'SKIPPED']).optional(),
    staffId: z.string().cuid().optional(),
    fromDate: z.string().datetime().optional(),
    toDate: z.string().datetime().optional(),
  }),
})

/** Schema for getting a single verification */
export const getSaleVerificationSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
    verificationId: z.string().cuid({ message: 'El ID de la verificación debe ser un CUID válido.' }),
  }),
})
