// src/controllers/dashboard/tenderType.dashboard.controller.ts

/**
 * VenueTenderType catalog — thin controller layer (HTTP only, no business logic).
 * @see src/services/dashboard/tenderType.dashboard.service.ts
 */

import { Request, Response, NextFunction } from 'express'
import { OrderSource } from '@prisma/client'
import * as tenderTypeService from '@/services/dashboard/tenderType.dashboard.service'
import { createTenderTypeBodySchema, updateTenderTypeBodySchema } from '@/schemas/dashboard/tenderType.schema'

/**
 * GET /api/v1/dashboard/venues/:venueId/tender-types
 * Full catalog (system + custom, active + disabled) — the disabled section stays
 * visible by design ("apagado se VE"). Lazily seeds the system rows.
 */
export async function listTenderTypes(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const tenderTypes = await tenderTypeService.listTenderTypes(venueId)
    res.json({ tenderTypes })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/tender-types/commissions
 *
 * "¿Cuánto me cobró Uber Eats este mes?" — suma la comisión CONGELADA en cada cobro.
 * Rango opcional `?from=YYYY-MM-DD&to=YYYY-MM-DD`, interpretado en la zona del NEGOCIO.
 */
export async function getTenderCommissions(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { from, to } = req.query as { from?: string; to?: string }
    const report = await tenderTypeService.getTenderCommissionsReport(venueId, { from, to })
    res.json(report)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/tender-types
 */
export async function createTenderType(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { userId } = (req as any).authContext
    const body = createTenderTypeBodySchema.parse(req.body)
    const created = await tenderTypeService.createTenderType(
      venueId,
      { ...body, linkedOrderSource: (body.linkedOrderSource as OrderSource | null | undefined) ?? null },
      userId,
    )
    res.status(201).json({ tenderType: created })
  } catch (error) {
    next(error)
  }
}

/**
 * PATCH /api/v1/dashboard/venues/:venueId/tender-types/:tenderTypeId
 * Body carries `expectedRevision` (optimistic concurrency) — a stale editor gets 409.
 */
export async function updateTenderType(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, tenderTypeId } = req.params
    const { userId } = (req as any).authContext
    const { expectedRevision, ...changes } = updateTenderTypeBodySchema.parse(req.body)
    const updated = await tenderTypeService.updateTenderType(
      venueId,
      tenderTypeId,
      expectedRevision,
      { ...changes, linkedOrderSource: changes.linkedOrderSource as OrderSource | null | undefined },
      userId,
    )
    res.json({ tenderType: updated })
  } catch (error) {
    next(error)
  }
}
