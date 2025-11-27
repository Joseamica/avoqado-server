/**
 * Customer Dashboard Controller
 *
 * Thin HTTP orchestration layer.
 * Extracts req data → Calls service → Sends response.
 *
 * Business logic lives in customer.dashboard.service.ts (HTTP-agnostic).
 *
 * @see src/controllers/dashboard/venue.dashboard.controller.ts:1-21 - Thin controller pattern explained
 */

import { NextFunction, Request, Response } from 'express'
import * as customerService from '@/services/dashboard/customer.dashboard.service'

/**
 * GET /api/dashboard/:venueId/customers
 * Get all customers with pagination and filters
 */
export async function getCustomers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    const { page, pageSize, search, customerGroupId, noGroup, tags } = req.query

    const result = await customerService.getCustomers(
      venueId,
      page ? Number(page) : undefined,
      pageSize ? Number(pageSize) : undefined,
      search as string | undefined,
      customerGroupId as string | undefined,
      noGroup === 'true',
      tags as string | undefined,
    )

    res.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/dashboard/:venueId/customers/:customerId
 * Get a single customer by ID
 */
export async function getCustomerById(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, customerId } = req.params

    const customer = await customerService.getCustomerById(venueId, customerId)

    res.status(200).json(customer)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/dashboard/:venueId/customers
 * Create a new customer
 */
export async function createCustomer(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    const customerData = req.body

    const customer = await customerService.createCustomer(venueId, customerData)

    res.status(201).json({
      message: 'Customer created successfully',
      customer,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * PUT /api/dashboard/:venueId/customers/:customerId
 * Update an existing customer
 */
export async function updateCustomer(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, customerId } = req.params
    const updateData = req.body

    const customer = await customerService.updateCustomer(venueId, customerId, updateData)

    res.status(200).json({
      message: 'Customer updated successfully',
      customer,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /api/dashboard/:venueId/customers/:customerId
 * Soft delete a customer (set active=false)
 */
export async function deleteCustomer(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, customerId } = req.params

    const result = await customerService.deleteCustomer(venueId, customerId)

    res.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/dashboard/:venueId/customers/stats
 * Get customer statistics for dashboard
 */
export async function getCustomerStats(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params

    const stats = await customerService.getCustomerStats(venueId)

    res.status(200).json(stats)
  } catch (error) {
    next(error)
  }
}
