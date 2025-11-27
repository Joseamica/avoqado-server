/**
 * Customer Group Controller (Thin HTTP Layer)
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
 */

import { Request, Response } from 'express'
import * as customerGroupService from '@/services/dashboard/customerGroup.dashboard.service'

/**
 * GET /api/dashboard/venues/:venueId/customer-groups
 * Get all customer groups with pagination and search
 */
export async function getCustomerGroups(req: Request, res: Response) {
  const { venueId } = req.params
  const { page, pageSize, search } = req.query

  const result = await customerGroupService.getCustomerGroups(venueId, {
    page: page ? Number(page) : undefined,
    pageSize: pageSize ? Number(pageSize) : undefined,
    search: search as string,
  })

  return res.status(200).json(result)
}

/**
 * GET /api/dashboard/venues/:venueId/customer-groups/stats
 * Get customer group statistics
 */
export async function getCustomerGroupStats(req: Request, res: Response) {
  const { venueId } = req.params

  const result = await customerGroupService.getCustomerGroupStats(venueId)

  return res.status(200).json(result)
}

/**
 * GET /api/dashboard/venues/:venueId/customer-groups/:groupId
 * Get a single customer group by ID with detailed stats
 */
export async function getCustomerGroupById(req: Request, res: Response) {
  const { venueId, groupId } = req.params

  const result = await customerGroupService.getCustomerGroupById(venueId, groupId)

  return res.status(200).json(result)
}

/**
 * POST /api/dashboard/venues/:venueId/customer-groups
 * Create a new customer group
 */
export async function createCustomerGroup(req: Request, res: Response) {
  const { venueId } = req.params
  const data = req.body

  const result = await customerGroupService.createCustomerGroup(venueId, data)

  return res.status(201).json(result)
}

/**
 * PUT /api/dashboard/venues/:venueId/customer-groups/:groupId
 * Update a customer group
 */
export async function updateCustomerGroup(req: Request, res: Response) {
  const { venueId, groupId } = req.params
  const data = req.body

  const result = await customerGroupService.updateCustomerGroup(venueId, groupId, data)

  return res.status(200).json(result)
}

/**
 * DELETE /api/dashboard/venues/:venueId/customer-groups/:groupId
 * Delete a customer group (soft delete)
 */
export async function deleteCustomerGroup(req: Request, res: Response) {
  const { venueId, groupId } = req.params

  const result = await customerGroupService.deleteCustomerGroup(venueId, groupId)

  return res.status(200).json(result)
}

/**
 * POST /api/dashboard/venues/:venueId/customer-groups/:groupId/assign
 * Assign customers to a group
 */
export async function assignCustomersToGroup(req: Request, res: Response) {
  const { venueId, groupId } = req.params
  const { customerIds } = req.body

  const result = await customerGroupService.assignCustomersToGroup(venueId, groupId, customerIds)

  return res.status(200).json(result)
}

/**
 * POST /api/dashboard/venues/:venueId/customer-groups/:groupId/remove
 * Remove customers from a group
 */
export async function removeCustomersFromGroup(req: Request, res: Response) {
  const { venueId, groupId } = req.params
  const { customerIds } = req.body

  const result = await customerGroupService.removeCustomersFromGroup(venueId, groupId, customerIds)

  return res.status(200).json(result)
}
