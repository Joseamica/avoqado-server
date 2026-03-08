import { z } from 'zod'

export const CreatePermissionSetSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'El nombre es requerido').max(50, 'El nombre no puede exceder 50 caracteres').trim(),
    description: z.string().max(200, 'La descripción no puede exceder 200 caracteres').trim().optional(),
    permissions: z.array(z.string().min(1)).min(1, 'Se requiere al menos un permiso'),
    color: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/, 'El color debe ser un código hexadecimal válido (ej: #7C3AED)')
      .optional(),
  }),
})

export const UpdatePermissionSetSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'El nombre es requerido').max(50, 'El nombre no puede exceder 50 caracteres').trim().optional(),
    description: z.string().max(200, 'La descripción no puede exceder 200 caracteres').trim().nullable().optional(),
    permissions: z.array(z.string().min(1)).min(1, 'Se requiere al menos un permiso').optional(),
    color: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/, 'El color debe ser un código hexadecimal válido (ej: #7C3AED)')
      .nullable()
      .optional(),
  }),
})

export const DuplicatePermissionSetSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'El nombre es requerido').max(50, 'El nombre no puede exceder 50 caracteres').trim(),
  }),
})

export type CreatePermissionSetInput = z.infer<typeof CreatePermissionSetSchema>['body']
export type UpdatePermissionSetInput = z.infer<typeof UpdatePermissionSetSchema>['body']
export type DuplicatePermissionSetInput = z.infer<typeof DuplicatePermissionSetSchema>['body']
