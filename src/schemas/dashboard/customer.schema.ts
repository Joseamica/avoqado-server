import { z } from 'zod'

// ==========================================
// PARAMETER SCHEMAS
// ==========================================

export const CustomerParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID'),
    customerId: z.string().cuid('Invalid customer ID'),
  }),
})

export const VenueIdParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID'),
  }),
})

// ==========================================
// QUERY SCHEMAS
// ==========================================

export const CustomersQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().optional(),
    customerGroupId: z.string().cuid().optional(),
    noGroup: z
      .string()
      .optional()
      .transform(val => val === 'true'), // Query params are strings, convert properly
    tags: z.string().optional(), // Comma-separated tags
    sortBy: z.enum(['createdAt', 'totalSpent', 'visitCount', 'lastVisit']).optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
    hasPendingBalance: z
      .string()
      .optional()
      .transform(val => val === 'true'), // Query params are strings, convert properly
  }),
})

// ==========================================
// BODY SCHEMAS
// ==========================================

export const CreateCustomerSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID'),
  }),
  body: z
    .object({
      email: z.string().email('Invalid email format').optional(),
      phone: z
        .string()
        .regex(/^\+?[0-9]{10,15}$/, 'Phone must be 10-15 digits (with optional + prefix)')
        .optional(),
      firstName: z.string().min(1, 'First name is required').max(50, 'First name too long').optional(),
      lastName: z.string().min(1, 'Last name is required').max(50, 'Last name too long').optional(),
      birthDate: z.coerce.date().optional(),
      gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY']).optional(),
      customerGroupId: z.string().cuid('Invalid customer group ID').optional(),
      notes: z.string().max(1000, 'Notes too long (max 1000 characters)').optional(),
      tags: z.array(z.string().max(50, 'Tag too long (max 50 characters)')).optional(),
      marketingConsent: z.boolean().default(false),
    })
    .refine(data => data.email || data.phone, {
      message: 'Either email or phone must be provided',
      path: ['email'], // Show error on email field
    }),
})

export const UpdateCustomerSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID'),
    customerId: z.string().cuid('Invalid customer ID'),
  }),
  body: z
    .object({
      email: z.string().email('Invalid email format').optional(),
      phone: z
        .string()
        .regex(/^\+?[0-9]{10,15}$/, 'Phone must be 10-15 digits (with optional + prefix)')
        .optional(),
      firstName: z.string().min(1, 'First name is required').max(50, 'First name too long').optional(),
      lastName: z.string().min(1, 'Last name is required').max(50, 'Last name too long').optional(),
      birthDate: z.coerce.date().optional(),
      gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY']).optional(),
      customerGroupId: z.string().cuid('Invalid customer group ID').nullable().optional(),
      notes: z.string().max(1000, 'Notes too long (max 1000 characters)').optional(),
      tags: z.array(z.string().max(50, 'Tag too long (max 50 characters)')).optional(),
      marketingConsent: z.boolean().optional(),
      active: z.boolean().optional(),
    })
    .refine(data => Object.keys(data).length > 0, {
      message: 'At least one field is required for update',
    }),
})

// ==========================================
// TYPE EXPORTS
// ==========================================

export type CreateCustomerDTO = z.infer<typeof CreateCustomerSchema>['body']
export type UpdateCustomerDTO = z.infer<typeof UpdateCustomerSchema>['body']
export type CustomersQueryDTO = z.infer<typeof CustomersQuerySchema>['query']
export type CustomerParamsDTO = z.infer<typeof CustomerParamsSchema>['params']
