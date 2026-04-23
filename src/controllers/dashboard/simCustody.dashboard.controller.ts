/**
 * Dashboard controllers for SIM custody (plan §1.4).
 *
 * Endpoints (mounted under /dashboard/organizations/:orgId/sim-custody):
 *   POST /assign-to-supervisor     OWNER
 *   POST /assign-to-promoter       MANAGER (owning supervisor only)
 *   POST /collect-from-promoter    MANAGER
 *   POST /collect-from-supervisor  OWNER
 *   GET  /events                   OWNER | MANAGER (timeline)
 *
 * Thin controllers: validate input (Zod ES), assert tenant, delegate to
 * SimCustodyService. All error codes match sim-custody-error-codes.ts.
 */

import { Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { StaffRole } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { simCustodyService } from '../../services/serialized-inventory/custody.service'
import { SIM_CUSTODY_ERROR_CODES, SimCustodyError } from '../../lib/sim-custody-error-codes'

// ==========================================
// SCHEMAS (Zod, Spanish messages per project rule)
// ==========================================

const AssignToSupervisorBody = z.object({
  supervisorStaffId: z.string().min(1, 'El supervisor es requerido'),
  fallbackCategoryId: z.string().min(1).nullable().optional(),
  rows: z
    .array(
      z.object({
        serialNumber: z.string().min(1, 'El ICCID es requerido'),
        categoryId: z.string().min(1).nullable().optional(),
      }),
    )
    .min(1, 'Debes incluir al menos un SIM')
    .max(500, 'Máximo 500 SIMs por solicitud'),
})

const AssignToPromoterBody = z.object({
  promoterStaffId: z.string().min(1, 'El promotor es requerido'),
  serialNumbers: z.array(z.string().min(1)).min(1, 'Debes incluir al menos un SIM').max(500, 'Máximo 500 SIMs por solicitud'),
})

const CollectBody = z.object({
  serialNumber: z.string().min(1, 'El ICCID es requerido'),
  reason: z.enum(['STAFF_TERMINATED', 'DAMAGED_SIM'], {
    errorMap: () => ({ message: 'Motivo inválido' }),
  }),
})

// ==========================================
// HELPERS
// ==========================================

function respondSimCustodyError(res: Response, err: unknown): boolean {
  if (err instanceof SimCustodyError) {
    res.status(err.httpStatus).json({ error: err.code, message: err.message })
    return true
  }
  return false
}

async function requireOrgMembership(userId: string, orgId: string): Promise<StaffRole | null> {
  // Returns the highest venue-role the user holds within this org, or null.
  const sv = await prisma.staffVenue.findFirst({
    where: { staffId: userId, venue: { organizationId: orgId } },
    orderBy: { startDate: 'asc' },
    select: { role: true },
  })
  return sv?.role ?? null
}

function mapZodError(res: Response, err: z.ZodError) {
  res.status(400).json({
    error: 'VALIDATION_ERROR',
    message: err.errors[0]?.message ?? 'Datos inválidos',
    issues: err.errors,
  })
}

// ==========================================
// CONTROLLERS
// ==========================================

export async function assignToSupervisor(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, orgId, role } = (req as any).authContext ?? {}
    const { orgId: paramOrgId } = req.params
    if (orgId !== paramOrgId && role !== 'SUPERADMIN') {
      const entry = SIM_CUSTODY_ERROR_CODES.TENANT_MISMATCH
      return res.status(entry.httpStatus).json({ error: entry.code, message: entry.messages.es })
    }

    const parse = AssignToSupervisorBody.safeParse(req.body)
    if (!parse.success) return mapZodError(res, parse.error)

    const result = await simCustodyService.assignToSupervisor({
      actor: { staffId: userId, organizationId: paramOrgId, role },
      supervisorStaffId: parse.data.supervisorStaffId,
      fallbackCategoryId: parse.data.fallbackCategoryId ?? null,
      rows: parse.data.rows,
      idempotencyRequestId: req.idempotency?.requestId ?? null,
    })
    res.status(200).json(result)
  } catch (err) {
    if (respondSimCustodyError(res, err)) return
    next(err)
  }
}

export async function assignToPromoter(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, orgId, role } = (req as any).authContext ?? {}
    const { orgId: paramOrgId } = req.params
    if (orgId !== paramOrgId && role !== 'SUPERADMIN') {
      const entry = SIM_CUSTODY_ERROR_CODES.TENANT_MISMATCH
      return res.status(entry.httpStatus).json({ error: entry.code, message: entry.messages.es })
    }

    const parse = AssignToPromoterBody.safeParse(req.body)
    if (!parse.success) return mapZodError(res, parse.error)

    const result = await simCustodyService.assignToPromoter({
      actor: { staffId: userId, organizationId: paramOrgId, role },
      promoterStaffId: parse.data.promoterStaffId,
      serialNumbers: parse.data.serialNumbers,
      idempotencyRequestId: req.idempotency?.requestId ?? null,
    })
    res.status(200).json(result)
  } catch (err) {
    if (respondSimCustodyError(res, err)) return
    next(err)
  }
}

/**
 * OWNER/SUPERADMIN bypass: asignar directo a Promotor saltando al Supervisor.
 * Reusa el mismo schema que /assign-to-promoter — la única diferencia es la
 * state machine (ADMIN_HELD → PROMOTER_PENDING) y el permiso requerido.
 */
export async function assignToPromoterDirect(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, orgId, role } = (req as any).authContext ?? {}
    const { orgId: paramOrgId } = req.params
    if (orgId !== paramOrgId && role !== 'SUPERADMIN') {
      const entry = SIM_CUSTODY_ERROR_CODES.TENANT_MISMATCH
      return res.status(entry.httpStatus).json({ error: entry.code, message: entry.messages.es })
    }

    const parse = AssignToPromoterBody.safeParse(req.body)
    if (!parse.success) return mapZodError(res, parse.error)

    const result = await simCustodyService.assignToPromoterDirect({
      actor: { staffId: userId, organizationId: paramOrgId, role },
      promoterStaffId: parse.data.promoterStaffId,
      serialNumbers: parse.data.serialNumbers,
      idempotencyRequestId: req.idempotency?.requestId ?? null,
    })
    res.status(200).json(result)
  } catch (err) {
    if (respondSimCustodyError(res, err)) return
    next(err)
  }
}

export async function collectFromPromoter(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, orgId, role } = (req as any).authContext ?? {}
    const { orgId: paramOrgId } = req.params
    if (orgId !== paramOrgId && role !== 'SUPERADMIN') {
      const entry = SIM_CUSTODY_ERROR_CODES.TENANT_MISMATCH
      return res.status(entry.httpStatus).json({ error: entry.code, message: entry.messages.es })
    }

    const parse = CollectBody.safeParse(req.body)
    if (!parse.success) return mapZodError(res, parse.error)

    const result = await simCustodyService.collectFromPromoter({
      actor: { staffId: userId, organizationId: paramOrgId, role },
      serialNumber: parse.data.serialNumber,
      reason: parse.data.reason,
    })
    res.status(200).json(result)
  } catch (err) {
    if (respondSimCustodyError(res, err)) return
    next(err)
  }
}

export async function collectFromSupervisor(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, orgId, role } = (req as any).authContext ?? {}
    const { orgId: paramOrgId } = req.params
    if (orgId !== paramOrgId && role !== 'SUPERADMIN') {
      const entry = SIM_CUSTODY_ERROR_CODES.TENANT_MISMATCH
      return res.status(entry.httpStatus).json({ error: entry.code, message: entry.messages.es })
    }

    const parse = CollectBody.safeParse(req.body)
    if (!parse.success) return mapZodError(res, parse.error)

    const result = await simCustodyService.collectFromSupervisor({
      actor: { staffId: userId, organizationId: paramOrgId, role },
      serialNumber: parse.data.serialNumber,
      reason: parse.data.reason,
    })
    res.status(200).json(result)
  } catch (err) {
    if (respondSimCustodyError(res, err)) return
    next(err)
  }
}

/** Timeline endpoint powering the SimTimelineDrawer in Dashboard §2.1.1. */
export async function listEvents(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, orgId, role } = (req as any).authContext ?? {}
    const { orgId: paramOrgId } = req.params
    if (orgId !== paramOrgId && role !== 'SUPERADMIN') {
      const entry = SIM_CUSTODY_ERROR_CODES.TENANT_MISMATCH
      return res.status(entry.httpStatus).json({ error: entry.code, message: entry.messages.es })
    }

    const venueRole = role === 'SUPERADMIN' ? 'SUPERADMIN' : await requireOrgMembership(userId, paramOrgId)
    if (!venueRole || !['OWNER', 'ADMIN', 'MANAGER', 'SUPERADMIN'].includes(venueRole)) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'No tienes acceso al timeline de custodia' })
    }

    const serialNumber = typeof req.query.serialNumber === 'string' ? req.query.serialNumber.trim() : ''
    if (!serialNumber) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'serialNumber es requerido' })
    }

    const events = await prisma.serializedItemCustodyEvent.findMany({
      where: {
        serialNumber,
        serializedItem: {
          OR: [{ organizationId: paramOrgId }, { venue: { organizationId: paramOrgId } }],
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
    })

    // Enrich with staff names so the dashboard timeline can show who the
    // supervisor / promoter actually is. Done as a separate query (not a
    // Prisma relation) because SerializedItemCustodyEvent intentionally uses
    // plain String FKs — events must survive Staff deletion for forensic use.
    const staffIds = Array.from(
      new Set(
        events.flatMap(e =>
          [e.fromStaffId, e.toStaffId, e.actorStaffId].filter((id): id is string => typeof id === 'string' && id.length > 0),
        ),
      ),
    )

    const staffById = new Map<string, { id: string; firstName: string | null; lastName: string | null }>()
    if (staffIds.length > 0) {
      const staffRows = await prisma.staff.findMany({
        where: { id: { in: staffIds } },
        select: { id: true, firstName: true, lastName: true },
      })
      for (const s of staffRows) staffById.set(s.id, s)
    }

    const hydrate = (id: string | null) => (id ? (staffById.get(id) ?? { id, firstName: null, lastName: null }) : null)

    const enrichedEvents = events.map(e => ({
      ...e,
      fromStaff: hydrate(e.fromStaffId),
      toStaff: hydrate(e.toStaffId),
      actorStaff: hydrate(e.actorStaffId),
    }))

    res.status(200).json({ serialNumber, events: enrichedEvents })
  } catch (err) {
    next(err)
  }
}
