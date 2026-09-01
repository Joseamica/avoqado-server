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
    const { page, pageSize, search, customerGroupId, noGroup, tags, sortBy, sortOrder, hasPendingBalance } = req.query

    const result = await customerService.getCustomers(
      venueId,
      page ? Number(page) : undefined,
      pageSize ? Number(pageSize) : undefined,
      search as string | undefined,
      customerGroupId as string | undefined,
      noGroup as boolean | undefined,
      tags as string | undefined,
      sortBy as 'createdAt' | 'totalSpent' | 'visitCount' | 'lastVisit' | undefined,
      sortOrder as 'asc' | 'desc' | undefined,
      hasPendingBalance as boolean | undefined,
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
 *
 * El actor sale de `authContext.userId` (patrón de `decideCustomerApproval` abajo): el
 * consentimiento de marketing que este endpoint pueda otorgar necesita quién lo capturó.
 */
export async function createCustomer(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    const customerData = req.body
    const { userId } = (req as any).authContext

    const customer = await customerService.createCustomer(venueId, customerData, userId)
    const { consentWarning, ...rest } = customer as typeof customer & {
      consentWarning?: { code: string; reason: string }
    }

    res.status(201).json({
      message: 'Customer created successfully',
      customer: rest,
      ...(consentWarning ? { warning: consentWarning.code, reason: consentWarning.reason } : {}),
    })
  } catch (error) {
    next(error)
  }
}

/**
 * PUT /api/dashboard/:venueId/customers/:customerId
 * Update an existing customer
 *
 * El actor sale de `authContext.userId`, igual que en create — necesario si el update
 * cambia `marketingConsent` (grant/revoke vía consent.service).
 */
export async function updateCustomer(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, customerId } = req.params
    const updateData = req.body
    const { userId } = (req as any).authContext

    const customer = await customerService.updateCustomer(venueId, customerId, updateData, userId)
    const { consentWarning, ...rest } = customer as typeof customer & {
      consentWarning?: { code: string; reason: string }
    }

    res.status(200).json({
      message: 'Customer updated successfully',
      customer: rest,
      ...(consentWarning ? { warning: consentWarning.code, reason: consentWarning.reason } : {}),
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

/**
 * POST /api/dashboard/:venueId/customers/:customerId/settle-balance
 * Settle pending balance for a customer (mark pay-later orders as paid)
 */
/**
 * Fase 1 — la bandeja "En espera de aprobación".
 */
export async function getCustomersAwaitingApproval(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    const { page, pageSize } = req.query as unknown as { page: number; pageSize: number }

    const result = await customerService.listCustomersAwaitingApproval(venueId, { page, pageSize })

    res.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

/**
 * Fase 1 — aprobar o rechazar a un cliente para que pueda reservar en línea.
 *
 * El actor sale de `authContext.userId` (NUNCA del body): quién aprobó es dato de auditoría
 * y no puede venir del cliente HTTP.
 */
export async function decideCustomerApproval(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, customerId } = req.params
    const { decision, reason, expectedVersion } = req.body
    const { userId } = (req as any).authContext

    const result = await customerService.decideCustomerApprovalFromDashboard(venueId, customerId, {
      decision,
      reason,
      expectedVersion,
      actorStaffId: userId,
    })

    res.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

export async function settleCustomerBalance(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, customerId } = req.params
    const { notes } = req.body

    const result = await customerService.settleCustomerBalance(venueId, customerId, notes)

    res.status(200).json(result)
  } catch (error) {
    next(error)
  }
}
