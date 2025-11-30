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
  displayName: z.string().min(1, 'Display name is required').max(50, 'Display name must be 50 characters or less').trim(),
  description: z.string().max(200, 'Description must be 200 characters or less').trim().optional(),
  icon: z.string().max(50, 'Icon name must be 50 characters or less').trim().optional(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Color must be a valid hex color (e.g., #7C3AED)')
    .optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(100).optional(),
})

/**
 * Update Role Configs Schema (bulk upsert)
 *
 * Allows updating multiple role configs at once.
 * Each config item will be upserted (created if doesn't exist, updated if exists).
 */
export const UpdateRoleConfigsSchema = z.object({
  body: z.object({
    configs: z
      .array(RoleConfigItemSchema)
      .min(1, 'At least one role config is required')
      .max(9, 'Cannot update more than 9 role configs at once'), // There are only 9 roles
  }),
})

/**
 * Route Parameters for role config operations
 */
export const RoleConfigParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
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
}

/**
 * Full response type for GET /role-config endpoint
 */
export interface GetRoleConfigsResponse {
  configs: RoleConfigResponse[]
}
