/**
 * Venue Role Config Controller (Thin HTTP Layer)
 *
 * WHY: Orchestrate HTTP requests/responses without business logic.
 *
 * PATTERN: Thin Controller Architecture
 * - Extract data from req (params, query, body)
 * - Call service method (business logic lives there)
 * - Return HTTP response
 * - NO business logic here (calculations, validations, database queries)
 *
 * RESPONSIBILITIES:
 * ✅ Extract request data
 * ✅ Call service functions
 * ✅ Return HTTP responses
 * ❌ Business logic (belongs in service)
 * ❌ Database queries (belongs in service)
 *
 * Used by: Venues wanting custom role display names
 * (e.g., CASHIER → "Promotor" for events businesses)
 */

import { Request, Response } from 'express'

import * as venueRoleConfigService from '@/services/dashboard/venueRoleConfig.dashboard.service'

/**
 * GET /api/v1/dashboard/venues/:venueId/role-config
 * Get all role configs for a venue (with defaults for unconfigured roles)
 */
export async function getRoleConfigs(req: Request, res: Response) {
  const { venueId } = req.params

  const configs = await venueRoleConfigService.getVenueRoleConfigs(venueId)

  return res.status(200).json({
    configs,
  })
}

/**
 * PUT /api/v1/dashboard/venues/:venueId/role-config
 * Update role configs for a venue (bulk upsert)
 */
export async function updateRoleConfigs(req: Request, res: Response) {
  const { venueId } = req.params
  const { configs } = req.body

  const updatedConfigs = await venueRoleConfigService.updateVenueRoleConfigs(venueId, configs)

  return res.status(200).json({
    message: 'Role configs updated successfully',
    configs: updatedConfigs,
  })
}

/**
 * DELETE /api/v1/dashboard/venues/:venueId/role-config
 * Reset all role configs to defaults for a venue
 */
export async function resetRoleConfigs(req: Request, res: Response) {
  const { venueId } = req.params

  await venueRoleConfigService.resetAllRoleConfigs(venueId)

  // Return the default configs
  const configs = await venueRoleConfigService.getVenueRoleConfigs(venueId)

  return res.status(200).json({
    message: 'Role configs reset to defaults',
    configs,
  })
}
