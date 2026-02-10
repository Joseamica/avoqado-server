import { z } from 'zod'

// ===========================================
// PARAM SCHEMAS
// ===========================================

export const staffIdParamSchema = z.object({
  params: z.object({
    staffId: z.string().cuid('ID de usuario inválido'),
  }),
})

export const staffVenueParamSchema = z.object({
  params: z.object({
    staffId: z.string().cuid('ID de usuario inválido'),
    venueId: z.string().cuid('ID de sucursal inválido'),
  }),
})

export const staffOrgParamSchema = z.object({
  params: z.object({
    staffId: z.string().cuid('ID de usuario inválido'),
    organizationId: z.string().cuid('ID de organización inválido'),
  }),
})

// ===========================================
// QUERY SCHEMAS
// ===========================================

export const listStaffQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().optional(),
    active: z.enum(['true', 'false', 'all']).optional().default('all'),
    organizationId: z.string().cuid('ID de organización inválido').optional(),
    venueId: z.string().cuid('ID de sucursal inválido').optional(),
  }),
})

// ===========================================
// BODY SCHEMAS
// ===========================================

export const createStaffSchema = z.object({
  body: z.object({
    email: z.string().email('Correo electrónico inválido'),
    firstName: z.string().min(1, 'El nombre es requerido'),
    lastName: z.string().min(1, 'El apellido es requerido'),
    phone: z.string().optional(),
    password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres').optional(),
    organizationId: z.string().cuid('ID de organización inválido'),
    orgRole: z.enum(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'], {
      errorMap: () => ({ message: 'Rol de organización inválido' }),
    }),
    venueId: z.string().cuid('ID de sucursal inválido').optional(),
    venueRole: z
      .enum(['SUPERADMIN', 'OWNER', 'ADMIN', 'MANAGER', 'WAITER', 'CASHIER', 'KITCHEN', 'HOST', 'VIEWER'], {
        errorMap: () => ({ message: 'Rol de sucursal inválido' }),
      })
      .optional(),
    pin: z
      .string()
      .regex(/^\d{4,6}$/, 'El PIN debe tener entre 4 y 6 dígitos')
      .optional(),
  }),
})

export const updateStaffSchema = z.object({
  params: z.object({
    staffId: z.string().cuid('ID de usuario inválido'),
  }),
  body: z.object({
    firstName: z.string().min(1, 'El nombre es requerido').optional(),
    lastName: z.string().min(1, 'El apellido es requerido').optional(),
    phone: z.string().optional().nullable(),
    active: z.boolean().optional(),
    emailVerified: z.boolean().optional(),
  }),
})

export const assignOrgSchema = z.object({
  params: z.object({
    staffId: z.string().cuid('ID de usuario inválido'),
  }),
  body: z.object({
    organizationId: z.string().cuid('ID de organización inválido'),
    role: z.enum(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'], {
      errorMap: () => ({ message: 'Rol de organización inválido' }),
    }),
  }),
})

export const removeOrgSchema = z.object({
  params: z.object({
    staffId: z.string().cuid('ID de usuario inválido'),
    organizationId: z.string().cuid('ID de organización inválido'),
  }),
})

export const assignVenueSchema = z.object({
  params: z.object({
    staffId: z.string().cuid('ID de usuario inválido'),
  }),
  body: z.object({
    venueId: z.string().cuid('ID de sucursal inválido'),
    role: z.enum(['SUPERADMIN', 'OWNER', 'ADMIN', 'MANAGER', 'WAITER', 'CASHIER', 'KITCHEN', 'HOST', 'VIEWER'], {
      errorMap: () => ({ message: 'Rol de sucursal inválido' }),
    }),
    pin: z
      .string()
      .regex(/^\d{4,6}$/, 'El PIN debe tener entre 4 y 6 dígitos')
      .optional(),
  }),
})

export const updateVenueAssignmentSchema = z.object({
  params: z.object({
    staffId: z.string().cuid('ID de usuario inválido'),
    venueId: z.string().cuid('ID de sucursal inválido'),
  }),
  body: z.object({
    role: z
      .enum(['SUPERADMIN', 'OWNER', 'ADMIN', 'MANAGER', 'WAITER', 'CASHIER', 'KITCHEN', 'HOST', 'VIEWER'], {
        errorMap: () => ({ message: 'Rol de sucursal inválido' }),
      })
      .optional(),
    pin: z
      .string()
      .regex(/^\d{4,6}$/, 'El PIN debe tener entre 4 y 6 dígitos')
      .optional()
      .nullable(),
    active: z.boolean().optional(),
  }),
})

export const resetPasswordSchema = z.object({
  params: z.object({
    staffId: z.string().cuid('ID de usuario inválido'),
  }),
  body: z.object({
    newPassword: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
  }),
})
