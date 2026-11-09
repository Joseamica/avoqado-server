/**
 * Customer Group Zod Validation Schemas
 *
 * WHY: Type-safe request validation for customer group management.
 *
 * PATTERN: Zod schemas → Controllers validate → Services execute
 * - Schemas define shape and constraints
 * - Controllers call .parse() to validate requests
 * - Services receive validated data (no need to re-validate)
 */

import { z } from 'zod'

/**
 * Create Customer Group Schema
 */
export const CreateCustomerGroupSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'El nombre del grupo es obligatorio').max(100, 'El nombre del grupo admite hasta 100 caracteres').trim(),
    description: z.string().max(500, 'La descripción admite hasta 500 caracteres').trim().optional(),
    color: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/, 'El color debe ser un código hexadecimal válido, por ejemplo #FF5733')
      .optional(),
    autoAssignRules: z.record(z.any()).optional(), // JSON object for automatic group criteria
  }),
})

/**
 * Update Customer Group Schema
 */
export const UpdateCustomerGroupSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'El nombre del grupo es obligatorio').max(100).trim().optional(),
    description: z.string().max(500).trim().optional(),
    color: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/, 'El color debe ser un código hexadecimal válido')
      .optional(),
    autoAssignRules: z.record(z.any()).optional(),
    active: z.boolean().optional(),
  }),
})

/**
 * Query Parameters for GET /customer-groups
 */
export const CustomerGroupsQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().optional(),
    pageSize: z.coerce.number().int().positive().max(100).optional(),
    search: z.string().trim().optional(),
  }),
})

/**
 * Route Parameters for single customer group operations
 */
export const CustomerGroupParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('El ID del negocio no es válido'),
    groupId: z.string().cuid('El ID del grupo no es válido'),
  }),
})

/**
 * Assign Customers to Group Schema
 */
export const AssignCustomersSchema = z.object({
  body: z.object({
    customerIds: z
      .array(z.string().cuid('El ID del cliente no es válido'))
      .min(1, 'Selecciona al menos un cliente')
      .max(100, 'No puedes asignar más de 100 clientes a la vez'),
  }),
})

/**
 * Remove Customers from Group Schema
 */
export const RemoveCustomersSchema = z.object({
  body: z.object({
    customerIds: z
      .array(z.string().cuid('El ID del cliente no es válido'))
      .min(1, 'Selecciona al menos un cliente')
      .max(100, 'No puedes quitar más de 100 clientes a la vez'),
  }),
})

/**
 * TypeScript types inferred from schemas
 */
export type CreateCustomerGroupInput = z.infer<typeof CreateCustomerGroupSchema>['body']
export type UpdateCustomerGroupInput = z.infer<typeof UpdateCustomerGroupSchema>['body']
export type CustomerGroupsQuery = z.infer<typeof CustomerGroupsQuerySchema>['query']
export type AssignCustomersInput = z.infer<typeof AssignCustomersSchema>['body']
export type RemoveCustomersInput = z.infer<typeof RemoveCustomersSchema>['body']
