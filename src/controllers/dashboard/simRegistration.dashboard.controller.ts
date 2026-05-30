/**
 * Dashboard controllers para solicitudes de alta de SIMs.
 * Montado bajo /dashboard/organizations/:orgId/sim-registration-requests.
 * Thin: valida (Zod ES) + tenant check + delega a SimRegistrationService.
 */
import { Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { simRegistrationService } from '../../services/serialized-inventory/simRegistration.service'

// ==========================================
// SCHEMAS (Zod, Spanish messages per project rule)
// ==========================================

const ApproveBody = z.object({
  categoryId: z.string().min(1, 'La categoría es requerida'),
  serialNumbers: z.array(z.string().min(1)).optional(),
})

const ApproveStockBody = z.object({
  serializedItemIds: z
    .array(z.string().min(1))
    .min(1, 'Se requiere al menos un artículo')
    .max(500, 'Máximo 500 artículos por solicitud'),
})

const RejectBody = z.object({
  reason: z.string().min(1, 'El motivo es requerido'),
  serialNumbers: z.array(z.string().min(1)).optional(),
})

// ==========================================
// HELPERS
// ==========================================

function mapZodError(res: Response, error: z.ZodError) {
  res.status(400).json({
    error: 'VALIDATION_ERROR',
    message: error.errors[0]?.message ?? 'Datos inválidos',
    issues: error.errors,
  })
}

function tenantOk(req: Request): boolean {
  const { orgId, role } = (req as any).authContext ?? {}
  return orgId === req.params.orgId || role === 'SUPERADMIN'
}

// ==========================================
// CONTROLLERS
// ==========================================

export async function listRequests(req: Request, res: Response, next: NextFunction) {
  try {
    if (!tenantOk(req)) {
      return res.status(403).json({ error: 'TENANT_MISMATCH', message: 'Organización no coincide' })
    }
    const data = await simRegistrationService.listPending(req.params.orgId)
    res.status(200).json({ success: true, data })
  } catch (err) {
    next(err)
  }
}

export async function countRequests(req: Request, res: Response, next: NextFunction) {
  try {
    if (!tenantOk(req)) {
      return res.status(403).json({ error: 'TENANT_MISMATCH', message: 'Organización no coincide' })
    }
    const count = await simRegistrationService.countPending(req.params.orgId)
    res.status(200).json({ success: true, data: { count } })
  } catch (err) {
    next(err)
  }
}

export async function approveRequest(req: Request, res: Response, next: NextFunction) {
  try {
    if (!tenantOk(req)) {
      return res.status(403).json({ error: 'TENANT_MISMATCH', message: 'Organización no coincide' })
    }
    const parse = ApproveBody.safeParse(req.body)
    if (!parse.success) return mapZodError(res, parse.error)
    const { userId } = (req as any).authContext ?? {}
    const result = await simRegistrationService.approve({
      organizationId: req.params.orgId,
      requestId: req.params.id,
      reviewedByStaffId: userId,
      categoryId: parse.data.categoryId,
      serialNumbers: parse.data.serialNumbers,
    })
    res.status(200).json({ success: true, data: result })
  } catch (err) {
    if (err instanceof Error && err.message === 'REQUEST_NOT_FOUND') {
      return res.status(404).json({ error: 'REQUEST_NOT_FOUND', message: 'Solicitud no encontrada' })
    }
    next(err)
  }
}

export async function rejectRequest(req: Request, res: Response, next: NextFunction) {
  try {
    if (!tenantOk(req)) {
      return res.status(403).json({ error: 'TENANT_MISMATCH', message: 'Organización no coincide' })
    }
    const parse = RejectBody.safeParse(req.body)
    if (!parse.success) return mapZodError(res, parse.error)
    const { userId } = (req as any).authContext ?? {}
    const result = await simRegistrationService.reject({
      organizationId: req.params.orgId,
      requestId: req.params.id,
      reviewedByStaffId: userId,
      reason: parse.data.reason,
      serialNumbers: parse.data.serialNumbers,
    })
    res.status(200).json({ success: true, data: result })
  } catch (err) {
    if (err instanceof Error && err.message === 'REQUEST_NOT_FOUND') {
      return res.status(404).json({ error: 'REQUEST_NOT_FOUND', message: 'Solicitud no encontrada' })
    }
    next(err)
  }
}

// ==========================================
// STOCK-APPROVAL QUEUE (OWNER)
// ==========================================

export async function listStockApprovals(req: Request, res: Response, next: NextFunction) {
  try {
    if (!tenantOk(req)) {
      return res.status(403).json({ error: 'TENANT_MISMATCH', message: 'Organización no coincide' })
    }
    const { cursor, limit, search } = req.query as { cursor?: string; limit?: string; search?: string }
    const data = await simRegistrationService.listPendingStockApprovals(req.params.orgId, {
      cursor,
      limit: limit ? parseInt(limit, 10) : undefined,
      search,
    })
    res.status(200).json({ success: true, data })
  } catch (err) {
    next(err)
  }
}

export async function countStockApprovals(req: Request, res: Response, next: NextFunction) {
  try {
    if (!tenantOk(req)) {
      return res.status(403).json({ error: 'TENANT_MISMATCH', message: 'Organización no coincide' })
    }
    const count = await simRegistrationService.countPendingStockApprovals(req.params.orgId)
    res.status(200).json({ success: true, data: { count } })
  } catch (err) {
    next(err)
  }
}

export async function approveStockItems(req: Request, res: Response, next: NextFunction) {
  try {
    if (!tenantOk(req)) {
      return res.status(403).json({ error: 'TENANT_MISMATCH', message: 'Organización no coincide' })
    }
    const parse = ApproveStockBody.safeParse(req.body)
    if (!parse.success) return mapZodError(res, parse.error)
    const { userId } = (req as any).authContext ?? {}
    const result = await simRegistrationService.approveStockItems({
      organizationId: req.params.orgId,
      reviewedByStaffId: userId,
      serializedItemIds: parse.data.serializedItemIds,
    })
    res.status(200).json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}
