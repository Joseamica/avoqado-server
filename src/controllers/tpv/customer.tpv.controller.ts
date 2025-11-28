/**
 * Customer TPV Controller
 *
 * HTTP layer for TPV customer operations.
 * Thin controller - delegates business logic to service.
 *
 * @see docs/CUSTOMER_DISCOUNT_IMPLEMENTATION_PLAN.md - Phase 1 TPV Customer Lookup
 */

import { NextFunction, Request, Response } from 'express'
import * as customerTpvService from '@/services/tpv/customer.tpv.service'

interface SearchQuery {
  phone?: string
  email?: string
  q?: string
  limit?: string
}

interface QuickCreateBody {
  firstName?: string
  lastName?: string
  phone?: string
  email?: string
}

/**
 * Search customers for checkout
 *
 * Supports multiple search modes:
 * - ?phone=5551234567 - Search by phone
 * - ?email=test@example.com - Search by email
 * - ?q=María - General search (name, email, phone)
 *
 * GET /api/v1/tpv/venues/:venueId/customers/search
 */
export async function searchCustomers(
  req: Request<{ venueId: string }, unknown, unknown, SearchQuery>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const { phone, email, q, limit } = req.query
    const maxResults = limit ? parseInt(limit, 10) : 10

    let results

    if (phone) {
      // Phone search (most common at checkout)
      results = await customerTpvService.findCustomerByPhone(venueId, phone, maxResults)
    } else if (email) {
      // Email search
      results = await customerTpvService.findCustomerByEmail(venueId, email, maxResults)
    } else if (q) {
      // General search
      results = await customerTpvService.searchCustomers(venueId, q, maxResults)
    } else {
      // No search criteria - return recent customers
      results = await customerTpvService.getRecentCustomers(venueId, maxResults)
    }

    res.status(200).json({
      success: true,
      data: results,
      count: results.length,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get customer by ID for checkout confirmation
 *
 * GET /api/v1/tpv/venues/:venueId/customers/:customerId
 */
export async function getCustomer(req: Request<{ venueId: string; customerId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, customerId } = req.params

    const customer = await customerTpvService.getCustomerForCheckout(venueId, customerId)

    res.status(200).json({
      success: true,
      data: customer,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Quick create customer during checkout
 *
 * If customer with same phone/email exists, returns existing customer (no error).
 * This provides better UX for cashiers who don't know if customer exists.
 *
 * POST /api/v1/tpv/venues/:venueId/customers
 */
export async function quickCreateCustomer(
  req: Request<{ venueId: string }, unknown, QuickCreateBody>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const { firstName, lastName, phone, email } = req.body

    const customer = await customerTpvService.quickCreateCustomer(venueId, {
      firstName,
      lastName,
      phone,
      email,
    })

    res.status(201).json({
      success: true,
      data: customer,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get recent customers for quick selection
 *
 * GET /api/v1/tpv/venues/:venueId/customers/recent
 */
export async function getRecentCustomers(
  req: Request<{ venueId: string }, unknown, unknown, { limit?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 10

    const customers = await customerTpvService.getRecentCustomers(venueId, limit)

    res.status(200).json({
      success: true,
      data: customers,
      count: customers.length,
    })
  } catch (error) {
    next(error)
  }
}
