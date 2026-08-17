import { z } from 'zod'
import { PIN_REGEX, PIN_ERROR_MESSAGE } from './common/pin.schema'

// Authentication schemas
// NOTE: Allows 4-10 digits for flexible PIN length
// SECURITY: Longer PINs are more secure (10 digits = 10 billion combinations)
export const pinLoginSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
  }),
  body: z.object({
    pin: z
      .string()
      .min(4, { message: 'El PIN debe tener al menos 4 dígitos.' })
      .max(10, { message: 'El PIN no puede tener más de 10 dígitos.' })
      .regex(PIN_REGEX, { message: PIN_ERROR_MESSAGE }),
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

// Schema for send receipt endpoint
export const sendReceiptParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
    paymentId: z.string().cuid({ message: 'El ID del payment debe ser un CUID válido.' }),
  }),
})

export const sendReceiptBodySchema = z.object({
  body: z.object({
    recipientEmail: z.string().email({ message: 'El email debe ser válido.' }),
  }),
})

export const sendWhatsAppReceiptBodySchema = z.object({
  body: z.object({
    recipientPhone: z.string().min(10, { message: 'El teléfono debe tener al menos 10 dígitos.' }),
  }),
})

export const recordPaymentBodySchema = z.object({
  body: z
    .object({
      venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
      amount: z.number().int().nonnegative({ message: 'El monto debe ser un número entero no negativo (en centavos).' }),
      tip: z.number().int().min(0, { message: 'La propina debe ser un número entero no negativo (en centavos).' }),
      status: z.enum(['COMPLETED', 'PENDING', 'FAILED', 'PROCESSING', 'REFUNDED'], { message: 'Estado de pago inválido.' }),
      // BANK_TRANSFER y OTHER son los métodos que el mesero declara A MANO porque el
      // dinero NO pasó por Avoqado (terminal ajena, transferencia). Sin ellos la venta
      // rápida rechazaba el cobro con 400 y la única salida del mesero era marcarlo
      // efectivo — justo lo que descuadra el arqueo. CRYPTOCURRENCY y DIGITAL_WALLET
      // NO se aceptan a mano a propósito: los escribe el flujo del procesador.
      // 🔑 OPCIONAL desde 2026-08-17, y sólo cuando viaja `tenderTypeId`: con un tipo de
      // pago del catálogo el método fiscal lo decide el SERVER desde la revisión
      // congelada, no el cliente. El refine de abajo exige exactamente uno de los dos.
      method: z
        .enum(['CASH', 'CREDIT_CARD', 'DEBIT_CARD', 'DIGITAL_WALLET', 'BANK_TRANSFER', 'OTHER'], {
          message: 'Método de pago inválido.',
        })
        .optional(),

      // 🔑 Referencia al tipo de pago del negocio ("Uber Eats", "Vale de despensa").
      // Viaja SOLO la referencia {id, revisión}: comisión, cajón y forma SAT los
      // resuelve el server desde `VenueTenderTypeRevision`, para que editar el
      // catálogo mañana NO reinterprete un cobro de hoy.
      tenderTypeId: z.string().cuid({ message: 'El ID del tipo de pago debe ser un CUID válido.' }).optional(),
      // La revisión que el cajero tenía enfrente. Sin ella la referencia no es
      // verificable y el server no podría congelar la semántica correcta.
      tenderRevision: z.number().int().nonnegative({ message: 'La versión del tipo de pago debe ser un entero no negativo.' }).optional(),
      // 🔴 "Esta venta YA OCURRIÓ y viene de mi cola offline."
      //
      // Sólo lo manda la cola de reintentos del POS, nunca un cobro en vivo. Cambia una
      // cosa: con un tipo del catálogo se honra la revisión que el cajero tenía enfrente
      // al cobrar, aunque hoy exista una más nueva o el tipo se haya apagado después.
      // Sin esto, subir la comisión de un tipo el martes RECHAZA para siempre las ventas
      // del lunes que no habían sincronizado — atoradas en la cola, con un banner que el
      // cajero no puede quitar. Un desenlace ya ocurrido es un hecho, no se re-litiga.
      // Lo que NO relaja: la revisión referenciada tiene que EXISTIR.
      isOfflineReplay: z.boolean().optional(),
      // Detalle legible del cobro declarado a mano ("Tarjeta (terminal externa)").
      // nullable() NO es cosmético: iOS manda `externalSource: null` explícito en los
      // cobros normales, así que exigir string|undefined rechazaría cada cobro en
      // efectivo del iPad con un 400.
      externalSource: z.string().max(50).nullable().optional(),
      source: z.string().default('TPV'),
      splitType: z.enum(['PERPRODUCT', 'EQUALPARTS', 'CUSTOMAMOUNT', 'FULLPAYMENT'], { message: 'Tipo de división inválido.' }),
      staffId: z.string().min(1, { message: 'El ID del staff es requerido.' }),
      paidProductsId: z.array(z.string()).default([]),

      // 🔴 EL CLIENTE DE LA VENTA (2026-08-17). Hasta hoy este campo NO estaba declarado
      // y `validation.ts` REEMPLAZA `req.body` con el resultado de Zod: un `customerId`
      // enviado por el POS se DESCARTABA EN SILENCIO y la orden `FAST-*` nacía sin
      // cliente aunque el cajero lo hubiera seleccionado. Se perdían historial, CFDI y
      // atribución (verificado en un POS Android real: cobro de $100 con cliente → orden
      // con `customerId NULL`).
      //
      // 🔑 Deliberadamente NO es `.cuid()` como en los demás schemas de este archivo:
      // aquí el dinero YA se recibió cuando llega la petición, y un 400 por el FORMATO de
      // un id manda el cobro a la cola de reintentos con un error permanente. Es la misma
      // trampa que ya costó un cobro atorado para siempre en `terminalPaymentRequestId`
      // (min(1), no min(8)). Forma solamente; que exista y sea de ESTE venue lo decide el
      // servicio, que ante un cliente inválido registra la venta anónima y avisa.
      //
      // `nullable()` porque los clientes mandan `null` explícito en la venta anónima
      // (mismo patrón que `externalSource`): exigir string|undefined rechazaría cada
      // cobro sin cliente del iPad.
      //
      // 🔑 `.max(64)` DENTRO de `.catch(undefined)`, no como rechazo. La cota es real y
      // necesaria (con `BODY_JSON_LIMIT` de 1 MB, sin ella un cliente empuja ~1 MB de
      // string al `findUnique` y al meta del logger en CADA cobro); pero convertirla en
      // un 400 reintroduciría justo el modo de falla que este campo evita. Con `.catch`
      // un valor absurdo se DESCARTA —la venta se registra anónima— en vez de tumbar el
      // cobro. Mismo patrón que `issuerCountryCode` arriba: "evidencia inválida se
      // descarta en vez de rechazar un pago ya aprobado". Un cuid mide 25.
      customerId: z
        .string()
        .trim()
        .min(1, { message: 'El ID del cliente no puede estar vacío.' })
        .max(64, { message: 'El ID del cliente es demasiado largo.' })
        .nullable()
        .optional()
        .catch(undefined),

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

      // Additive issuer-country evidence for the shadow classifier. Old TPVs omit
      // both fields and continue through the legacy boolean path unchanged. Invalid
      // evidence is discarded instead of rejecting an otherwise approved payment.
      issuerCountryCode: z
        .preprocess(value => (value === null || value === undefined ? undefined : String(value)), z.string().trim().max(10).optional())
        .catch(undefined),
      issuerCountrySource: z.enum(['EMV_5F28', 'PROCESSOR']).optional().catch(undefined),

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
      // Blumon serial number format: 10-11 character alphanumeric string (e.g., "2841548417" or "A2841548418")
      // Used for TIER 2 merchant recovery when merchantAccountId is invalid/missing
      blumonSerialNumber: z
        .string()
        .regex(/^[A-Za-z0-9]{10,11}$/, { message: 'El serial Blumon debe ser alfanumérico de 10-11 caracteres' })
        .optional(),

      // Snapshot de MERCHANT_ROUTING_RULES evaluado por la TPV para este cobro
      // (auditoría "por qué se mostró/eligió este merchant"). Opcional — APKs viejos no lo envían.
      routingEvaluation: z
        .object({
          evaluatedAt: z.string({ message: 'evaluatedAt inválido' }),
          fallbackAll: z.boolean().optional(),
          autoSelected: z.boolean().optional(),
          eligibleIds: z.array(z.string()).max(20).optional(),
          reasons: z.record(z.string(), z.array(z.string()).max(10)).optional(),
        })
        .passthrough()
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

      // 💸 Blumon Operation Number (2025-12-16) - For refunds without webhook
      // Small integer from SDK response (response.operation) needed for CancelIcc refunds
      // Example: 12945658 (fits in Int, unlike the 12-digit referenceNumber)
      blumonOperationNumber: z.number().int().positive().optional(),

      // 📸 NON-BLOCKING PROOF-OF-SALE (2026-03-10)
      // For SERIALIZED_INVENTORY mode: backend creates PENDING SaleVerification record
      isPortabilidad: z.boolean().optional(),
      serialNumbers: z.array(z.string()).optional(),

      // 🛡️ IDEMPOTENCY KEY (2026-04-08) - Stripe/Square/Toast pattern
      // Client-generated UUID v4 sent ONCE per logical payment attempt and reused
      // on every retry of that attempt. Backend deduplicates atomically via the
      // unique index (venueId, idempotencyKey) in the Payment table.
      //
      // Backwards compatible: optional field. TPV versions < v1.10.10 do not send
      // it, and those requests fall back to the legacy referenceNumber-based check.
      //
      // Format: UUID v4 string (36 chars with hyphens, e.g. "a3f9b2c1-7e8d-4a5b-9c1e-2d3f4a5b6c7d").
      // Accepted as any string up to 64 chars to allow clients to use alternative
      // collision-resistant schemes (ULID, nanoid) if needed.
      idempotencyKey: z.string().min(8).max(64).optional(),
      // Links this Payment to the POS→TPV arbitration request (the POS-generated
      // requestId). When present, recording the Payment closes the arbitration
      // row + frees the terminal slot in the SAME transaction. Optional/additive:
      // TPV versions that don't send it fall back to the socket-result close.
      //
      // 🔴 min(1), NOT min(8) — this id is generated by the REQUESTING client
      // (`sendPaymentToTerminal` accepts any client requestId unvalidated), so its
      // length is not ours to police here. A former min(8) rejected the ENTIRE
      // money recording over a 7-char id → the payment got stuck in the TPV
      // offline queue forever (permanent 400, banner the cashier can't clear).
      // Server-side an unknown/short id is a harmless no-op (closeRowFromPaymentTx
      // findUnique miss → return). Recording money must never fail on a
      // correlation key's length. (idempotencyKey above KEEPS min(8): we generate
      // it and its length protects the double-charge dedup.)
      terminalPaymentRequestId: z.string().min(1).max(64).optional(),
    })
    .refine(
      data => {
        // ✅ Business rule: Card payments need merchantAccountId OR blumonSerialNumber (for TIER 2 recovery)
        // TIER 1: merchantAccountId provided directly
        // TIER 2: blumonSerialNumber allows backend to infer merchantAccountId (SOURCE OF TRUTH)
        // Sin `method` explícito manda el catálogo (tenderTypeId): la regla de merchant
        // no aplica — un tipo propio nunca cobra por una terminal de Avoqado.
        if (data.method == null) return true
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
    )
    // 🔴 DINERO: exactamente UNA fuente de verdad para la semántica del cobro.
    //
    // Con `tenderTypeId` manda el CATÁLOGO (comisión, cajón, forma SAT salen de la
    // revisión congelada); sin él manda `method`. Aceptar los dos obligaría al server
    // a elegir en silencio cuál gana — y esa elección decide si el dinero entra al
    // arqueo de efectivo o no. Se rechaza en la frontera.
    .superRefine((data, ctx) => {
      const tieneTender = data.tenderTypeId != null

      if (tieneTender && data.method != null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'No envíes method junto con tenderTypeId: el tipo de pago del catálogo ya define el método.',
          path: ['method'],
        })
      }

      if (!tieneTender && data.method == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Método de pago inválido.',
          path: ['method'],
        })
      }

      // Una referencia a medias no es verificable: sin revisión el server no sabe
      // QUÉ versión del tipo tenía el cajero enfrente al cobrar.
      if (tieneTender && data.tenderRevision == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Falta la versión del tipo de pago (tenderRevision).',
          path: ['tenderRevision'],
        })
      }

      if (!tieneTender && data.tenderRevision != null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'tenderRevision sin tenderTypeId no identifica ningún tipo de pago.',
          path: ['tenderTypeId'],
        })
      }
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
          // Venta por peso: kilos pesados. Obligatorio si el producto es
          // soldByWeight (el servicio valida la combinación y calcula el total).
          weightQuantity: z
            .number()
            .positive({ message: 'El peso debe ser mayor a 0.' })
            .max(99.999, { message: 'El peso máximo es 99.999 kg.' })
            .optional()
            .nullable(),
          notes: z.string().optional().nullable(),
          modifierIds: z.array(z.string().cuid()).optional(), // ✅ FIX: Allow modifier IDs to be sent from Android
          // 🔑 Llave idempotente por línea, generada por el cliente ANTES del primer
          // intento (formato `sync:<intentId>:<idx>`). Sin esto Zod la descartaba en
          // silencio y el caso DROP_RESPONSE —el server SÍ agregó la ronda pero la
          // respuesta se perdió— duplicaba la ronda al reintentar: cobrada dos veces
          // en el cheque y mandada dos veces a cocina.
          //
          // El servicio ya la respeta: `addItemsToOrder` hace findFirst por externalId
          // y ACTUALIZA en vez de insertar (order.tpv.service.ts:1438), que es la misma
          // ruta que usa el reducer de intents. Aquí sólo se destapa para la vía online.
          externalId: z.string().max(120, { message: 'El identificador externo es demasiado largo.' }).optional().nullable(),
        }),
      )
      .min(1, { message: 'Debe proporcionar al menos un ítem.' }),
    version: z.number().int().nonnegative({ message: 'La versión debe ser un entero no negativo.' }),
  }),
})

// All monetary fields below are pesos as decimals, matching the rest of the
// /tpv/* API (e.g. $25.45 is sent as 25.45, NOT as 2545 cents). The service
// validates subtotal/discount/total with ±$0.01 tolerance for rounding.
const createOrderWithItemsItemSchema = z
  .object({
    productId: z.string().cuid({ message: 'El ID del producto debe ser un CUID válido.' }).optional().nullable(),
    name: z.string().min(1, { message: 'El nombre del ítem custom es requerido.' }).optional().nullable(),
    quantity: z.number().int().positive({ message: 'La cantidad debe ser un entero positivo.' }),
    unitPrice: z.number().nonnegative({ message: 'El precio unitario debe ser un número no negativo en pesos.' }).optional().nullable(),
    modifierIds: z.array(z.string().cuid({ message: 'Los IDs de modificadores deben ser CUIDs válidos.' })).default([]),
    notes: z.string().optional().nullable(),
    isCortesia: z.boolean().default(false),
    cortesiaReason: z.string().optional().nullable(),
    itemDiscountId: z.string().cuid({ message: 'El ID del descuento debe ser un CUID válido.' }).optional().nullable(),
  })
  .refine(data => !!data.productId || (!!data.name && data.unitPrice != null), {
    message: 'Cada ítem debe tener productId o name + unitPrice.',
    path: ['productId'],
  })
  .refine(data => !data.isCortesia || !!data.cortesiaReason?.trim(), {
    message: 'La razón de cortesía es requerida.',
    path: ['cortesiaReason'],
  })
  .refine(data => !(data.isCortesia && data.itemDiscountId), {
    message: 'Un ítem no puede tener cortesía y descuento al mismo tiempo.',
    path: ['itemDiscountId'],
  })

export const createOrderWithItemsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
  }),
  body: z
    .object({
      items: z.array(createOrderWithItemsItemSchema).min(1, { message: 'Debe proporcionar al menos un ítem.' }),
      staffId: z.string().cuid({ message: 'El ID del staff debe ser un CUID válido.' }),
      orderType: z.enum(['DINE_IN', 'TAKEOUT', 'DELIVERY', 'PICKUP']).default('TAKEOUT'),
      source: z.string().default('TPV'),
      tableId: z.string().cuid({ message: 'El ID de la mesa debe ser un CUID válido.' }).optional().nullable(),
      customerId: z.string().cuid({ message: 'El ID del cliente debe ser un CUID válido.' }).optional().nullable(),
      discount: z.number().nonnegative({ message: 'El descuento debe ser un número no negativo en pesos.' }).default(0),
      orderDiscountId: z.string().cuid({ message: 'El ID del descuento debe ser un CUID válido.' }).optional().nullable(),
      taxAmount: z.number().nonnegative({ message: 'El impuesto debe ser un número no negativo en pesos.' }),
      tip: z.number().nonnegative({ message: 'La propina debe ser un número no negativo en pesos.' }).default(0),
      subtotal: z.number().nonnegative({ message: 'El subtotal debe ser un número no negativo en pesos.' }),
      total: z.number().nonnegative({ message: 'El total debe ser un número no negativo en pesos.' }),
      note: z.string().optional().nullable(),
      // Llave de idempotencia del cliente (retry-safety). ADITIVO: los TPV
      // viejos no la mandan y el comportamiento no cambia.
      externalId: z
        .string()
        .min(1, { message: 'externalId no puede estar vacío.' })
        .max(255, { message: 'externalId no puede exceder 255 caracteres.' })
        .optional()
        .nullable(),
    })
    .refine(data => data.taxAmount === 0, {
      message: 'taxAmount debe ser 0 en V1 del nuevo Cobrar (la fórmula del payment service aún no incluye tax).',
      path: ['taxAmount'],
    })
    .refine(data => data.tip === 0, {
      message: 'La propina se agrega en el flujo de pago, no al crear la orden.',
      path: ['tip'],
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

/** Schema for proof-of-sale photo upload (simplified verification) */
export const createProofOfSaleSchema = z.object({
  body: z.object({
    paymentId: z.string().cuid({ message: 'El ID del pago debe ser un CUID válido.' }),
    photoUrls: z
      .array(z.string().url({ message: 'Cada foto debe ser una URL válida.' }))
      .min(1, { message: 'Debe proporcionar al menos una foto.' }),
    verificationId: z.string().cuid({ message: 'El ID de verificación debe ser un CUID válido.' }).optional(),
    replaceIndex: z.number().int().min(0).max(1).optional(), // Replace photo at this index instead of appending
    photoLabel: z.enum(['Vinculacion', 'Portabilidad']).optional(), // Fixed slot: Vinculacion=0, Portabilidad=1
  }),
})

// ==========================================
// HEARTBEAT SCHEMA (con telemetría opcional de autorización)
// ==========================================

// Un intento de autorización local reportado por el batching de telemetría del TPV
// (Task 7). Sin datos de tarjeta ni montos — solo resultado/duración/riel/hora.
// `timestamp` es opcional a propósito: el payload real del TPV puede omitirlo.
const authAttemptSchema = z.object({
  code: z.string().min(1, { message: 'El código del intento es requerido.' }).max(50, { message: 'El código es demasiado largo.' }),
  durationMs: z.number().int().nonnegative({ message: 'La duración debe ser un entero no negativo.' }),
  rail: z.string().min(1, { message: 'El riel (rail) es requerido.' }).max(50, { message: 'El riel es demasiado largo.' }),
  timestamp: z.string().optional(),
})

// Terminales viejas instaladas NUNCA envían `authAttempts` — debe seguir siendo
// additive/opcional. `systemInfo` se mantiene permisivo (record arbitrario) porque
// ya viaja con forma libre desde el campo en producción.
export const heartbeatSchema = z.object({
  body: z.object({
    terminalId: z.string().min(1, { message: 'El terminalId es requerido.' }),
    timestamp: z.string().min(1, { message: 'El timestamp es requerido.' }),
    status: z.enum(['ACTIVE', 'MAINTENANCE'], { message: 'El status debe ser ACTIVE o MAINTENANCE.' }),
    version: z.string().optional(),
    systemInfo: z.record(z.string(), z.any()).optional(),
    // Lote de telemetría de autorización local (piggyback en el heartbeat). Tope de
    // 100 intentos por envío — coincide con el cap del batch del lado TPV; un lote
    // más grande se rechaza en vez de aceptarse silenciosamente.
    authAttempts: z.array(authAttemptSchema).max(100, { message: 'El lote de intentos de autorización es demasiado grande.' }).optional(),
  }),
})

/** Schema for TPV feedback (bug reports and feature suggestions) */
export const tpvFeedbackSchema = z.object({
  body: z.object({
    feedbackType: z.enum(['bug', 'feature'], { message: 'El tipo de feedback debe ser "bug" o "feature".' }),
    message: z.string().min(10, { message: 'El mensaje debe tener al menos 10 caracteres.' }),
    venueSlug: z.string().min(1, { message: 'El venueSlug es requerido.' }),
    appVersion: z.string().min(1, { message: 'La versión de la app es requerida.' }),
    buildVersion: z.string().min(1, { message: 'La versión del build es requerida.' }),
    androidVersion: z.string().min(1, { message: 'La versión de Android es requerida.' }),
    deviceModel: z.string().min(1, { message: 'El modelo del dispositivo es requerido.' }),
    deviceManufacturer: z.string().min(1, { message: 'El fabricante del dispositivo es requerido.' }),
  }),
})

// ==========================================
// CRYPTO PAYMENT SCHEMAS
// ==========================================

/** Schema for initiating a crypto payment */
export const initiateCryptoPaymentSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
  }),
  body: z.object({
    amount: z.number().int().positive({ message: 'El monto debe ser un número entero positivo (en centavos).' }),
    tip: z.number().int().min(0, { message: 'La propina debe ser un número entero no negativo (en centavos).' }).optional(),
    staffId: z.string().cuid({ message: 'El ID del staff debe ser un CUID válido.' }),
    shiftId: z.string().cuid({ message: 'El ID del turno debe ser un CUID válido.' }).optional(),
    orderId: z.string().cuid({ message: 'El ID del order debe ser un CUID válido.' }).optional(),
    orderNumber: z.string().optional(),
    deviceSerialNumber: z.string().optional(),
    rating: z.number().int().min(1).max(5).optional(),
  }),
})

/** Schema for cancelling a crypto payment */
export const cancelCryptoPaymentSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
  }),
  body: z
    .object({
      paymentId: z.string().cuid({ message: 'El ID del pago debe ser un CUID válido.' }).optional(),
      requestId: z.string().optional(),
      reason: z.string().optional(),
    })
    .refine(data => data.paymentId || data.requestId, {
      message: 'paymentId or requestId is required',
    }),
})

/** Schema for getting crypto payment status */
export const getCryptoPaymentStatusSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
    requestId: z.string().min(1, { message: 'El requestId de B4Bit es requerido.' }),
  }),
})
