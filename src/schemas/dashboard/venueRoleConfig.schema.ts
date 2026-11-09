/**
 * Venue Role Config Zod Validation Schemas
 *
 * WHY: Type-safe request validation for custom role display names.
 *
 * PATTERN: Zod schemas → Controllers validate → Services execute
 * - Schemas define shape and constraints
 * - Controllers call .parse() to validate requests
 * - Services receive validated data (no need to re-validate)
 *
 * Used by: Events/concerts businesses that want custom role names
 * (e.g., CASHIER → "Promotor", WAITER → "Staff de Evento")
 */

import { StaffRole } from '@prisma/client'
import { z } from 'zod'

/**
 * StaffRole enum as Zod enum for validation
 */
const StaffRoleEnum = z.enum(['SUPERADMIN', 'OWNER', 'ADMIN', 'MANAGER', 'CASHIER', 'WAITER', 'KITCHEN', 'HOST', 'VIEWER'])

/**
 * Single role config item (for bulk updates)
 */
const RoleConfigItemSchema = z.object({
  role: StaffRoleEnum,
  displayName: z.string().min(1, 'El nombre del rol es obligatorio').max(50, 'El nombre del rol admite hasta 50 caracteres').trim(),
  description: z.string().max(200, 'La descripción del rol admite hasta 200 caracteres').trim().optional(),
  icon: z.string().max(50, 'El nombre del ícono admite hasta 50 caracteres').trim().optional(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'El color debe ser un código hexadecimal válido, por ejemplo #7C3AED')
    .optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(100).optional(),
  /** ¿Aparece en el selector de "Vendedor" del POS? Ausente = no se toca. */
  showAsSeller: z.boolean().optional(),
})

/**
 * Update Role Configs Schema (bulk upsert)
 *
 * Allows updating multiple role configs at once.
 * Each config item will be upserted (created if doesn't exist, updated if exists).
 */
export const UpdateRoleConfigsSchema = z.object({
  body: z.object({
    configs: z.array(RoleConfigItemSchema).min(1, 'Indica al menos un rol').max(9, 'No puedes actualizar más de 9 roles a la vez'), // There are only 9 roles
  }),
})

/**
 * Route Parameters for role config operations
 */
export const RoleConfigParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('El ID del negocio no es válido'),
  }),
})

/**
 * TypeScript types inferred from schemas
 */
export type RoleConfigItem = z.infer<typeof RoleConfigItemSchema>
export type UpdateRoleConfigsInput = z.infer<typeof UpdateRoleConfigsSchema>['body']

/**
 * Response type for role configs (includes all fields)
 * Used for type-safe responses from service layer
 */
export interface RoleConfigResponse {
  role: StaffRole
  displayName: string
  description: string | null
  icon: string | null
  color: string | null
  isActive: boolean
  sortOrder: number
  /** ¿Aparece en el selector de "Vendedor" del POS? Default true. */
  showAsSeller: boolean
}

/**
 * Full response type for GET /role-config endpoint
 */
export interface GetRoleConfigsResponse {
  configs: RoleConfigResponse[]
}
