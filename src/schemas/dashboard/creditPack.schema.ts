import { z } from 'zod'

// ==========================================
// DASHBOARD SCHEMAS
// ==========================================

export const createCreditPackSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'El nombre es requerido'),
    description: z.string().optional(),
    price: z.number().positive('El precio debe ser mayor a 0'),
    currency: z.string().default('MXN'),
    validityDays: z.number().int().positive('Los dias de vigencia deben ser mayor a 0').optional(),
    maxPerCustomer: z.number().int().positive('El limite por cliente debe ser mayor a 0').optional(),
    displayOrder: z.number().int().min(0).optional(),
    items: z
      .array(
        z.object({
          productId: z.string().min(1, 'El producto es requerido'),
          quantity: z.number().int().positive('La cantidad debe ser mayor a 0'),
        }),
      )
      .min(1, 'El paquete debe tener al menos un item'),
  }),
})

export const updateCreditPackSchema = z.object({
  params: z.object({
    packId: z.string().min(1),
  }),
  body: z.object({
    name: z.string().min(1, 'El nombre es requerido').optional(),
    description: z.string().nullable().optional(),
    price: z.number().positive('El precio debe ser mayor a 0').optional(),
    currency: z.string().optional(),
    validityDays: z.number().int().positive().nullable().optional(),
    maxPerCustomer: z.number().int().positive().nullable().optional(),
    displayOrder: z.number().int().min(0).optional(),
    items: z
      .array(
        z.object({
          productId: z.string().min(1, 'El producto es requerido'),
          quantity: z.number().int().positive('La cantidad debe ser mayor a 0'),
        }),
      )
      .min(1, 'El paquete debe tener al menos un item')
      .optional(),
  }),
})

export const packIdParamsSchema = z.object({
  params: z.object({
    packId: z.string().min(1),
  }),
})

export const balanceIdParamsSchema = z.object({
  params: z.object({
    balanceId: z.string().min(1),
  }),
})

export const purchaseIdParamsSchema = z.object({
  params: z.object({
    purchaseId: z.string().min(1),
  }),
})

export const customerIdParamsSchema = z.object({
  params: z.object({
    customerId: z.string().min(1),
  }),
})

export const redeemBodySchema = z.object({
  body: z.object({
    reason: z.string().optional(),
  }),
})

export const adjustBodySchema = z.object({
  body: z.object({
    quantity: z
      .number()
      .int()
      .refine(n => n !== 0, 'La cantidad no puede ser 0'),
    reason: z.string().min(1, 'La razon es requerida'),
  }),
})

export const refundBodySchema = z.object({
  body: z.object({
    reason: z.string().min(1, 'La razon es requerida'),
  }),
})

export const purchasesQuerySchema = z.object({
  query: z
    .object({
      customerId: z.string().optional(),
      status: z.enum(['ACTIVE', 'EXHAUSTED', 'EXPIRED', 'REFUNDED']).optional(),
      page: z.coerce.number().int().positive().default(1),
      limit: z.coerce.number().int().positive().max(100).default(20),
    })
    .optional()
    .default({}),
})

export const transactionsQuerySchema = z.object({
  query: z
    .object({
      customerId: z.string().optional(),
      type: z.enum(['PURCHASE', 'REDEEM', 'EXPIRE', 'REFUND', 'ADJUST']).optional(),
      page: z.coerce.number().int().positive().default(1),
      limit: z.coerce.number().int().positive().max(100).default(20),
    })
    .optional()
    .default({}),
})

// ==========================================
// PUBLIC SCHEMAS
// ==========================================

export const publicCheckoutSchema = z.object({
  params: z.object({
    venueSlug: z.string().min(1),
    packId: z.string().min(1),
  }),
  body: z.object({
    email: z.string().email('Email invalido').optional(),
    phone: z.string().min(1, 'El telefono es requerido'),
    successUrl: z.string().url('URL de exito invalida'),
    cancelUrl: z.string().url('URL de cancelacion invalida'),
  }),
})

export const publicBalanceQuerySchema = z.object({
  params: z.object({
    venueSlug: z.string().min(1),
  }),
  query: z.object({
    email: z.string().email().optional(),
    phone: z.string().optional(),
  }),
})

export const publicPacksParamsSchema = z.object({
  params: z.object({
    venueSlug: z.string().min(1),
  }),
})

export const customerRegisterSchema = z.object({
  params: z.object({
    venueSlug: z.string().min(1),
  }),
  body: z.object({
    email: z.string().email('Correo inválido'),
    password: z.string().min(6, 'La contraseña debe tener al menos 6 caracteres'),
    phone: z.string().optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
  }),
})

export const customerLoginSchema = z.object({
  params: z.object({
    venueSlug: z.string().min(1),
  }),
  body: z.object({
    email: z.string().email('Correo inválido'),
    password: z.string().min(1, 'La contraseña es requerida'),
  }),
})

export const customerUpdateProfileSchema = z.object({
  params: z.object({
    venueSlug: z.string().min(1),
  }),
  body: z
    .object({
      firstName: z.string().max(50, 'El nombre es muy largo').optional(),
      lastName: z.string().max(50, 'El apellido es muy largo').optional(),
      phone: z
        .string()
        .regex(/^\+?[0-9]{10,15}$/, 'El teléfono debe tener entre 10 y 15 dígitos')
        .optional(),
    })
    .refine(data => Object.keys(data).length > 0, {
      message: 'Se requiere al menos un campo para actualizar',
    }),
})
