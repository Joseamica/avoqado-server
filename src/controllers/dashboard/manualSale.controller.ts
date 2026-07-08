import { NextFunction, Request, Response } from 'express'

import { bulkManualSales } from '@/services/dashboard/manualSale.service'
import { moduleService, MODULE_CODES } from '@/services/modules/module.service'
import prisma from '@/utils/prismaClient'
import type { BulkManualSalesInput } from '@/schemas/dashboard/manualSale.schema'

/**
 * Controller for "Subir ventas fuera de TPV" — bulk upload of SIM sales made
 * outside the TPV (PlayTelecom / Walmart). Two org-scoped handlers back the two
 * endpoints declared in `organizationDashboard.routes.ts`:
 *
 *   preview → bulkManualSales(orgId, actor, rows, apply=false)  (dry, read-only)
 *   apply   → bulkManualSales(orgId, actor, rows, apply=true)   (writes one sale/row)
 *
 * Both gate on the SERIALIZED_INVENTORY module for the org BEFORE calling the
 * service. Because SERIALIZED_INVENTORY is (for PlayTelecom) enabled at the ORG
 * level via `OrganizationModule`, we resolve ONE venue in the org and defer to
 * `moduleService.isModuleEnabled(venueId, …)`, whose resolution order is
 * VenueModule → OrganizationModule fallback — so an org-level enablement is
 * honored, and a venue-level override on that venue wins if present. This mirrors
 * how every other serialized path gates (feature-gating.md: serialized inventory
 * is a Module code, NEVER the Feature/tier resolver). If the org has no venue, or
 * none with the module enabled at either level → 403.
 *
 * Actor comes from `authContext` (NOT req.user). Audit of each created sale is
 * already handled inside the service (Task 4). Row-level classification (crear /
 * omitir / error, cross-org ICCID handling, dedup) all lives in the service too
 * (Task 5) — the controller only wires HTTP ↔ service and enforces the module gate.
 */

const MODULE_DISABLED_MESSAGE = 'Módulo de inventario serializado no habilitado'

/**
 * Returns true iff at least one venue in the org resolves SERIALIZED_INVENTORY as
 * enabled (venue-level override OR org-level inheritance). Iterates venues so an
 * org-level enablement is caught even when no venue carries an explicit
 * VenueModule row. Short-circuits on the first enabled venue.
 */
async function isSerializedInventoryEnabledForOrg(orgId: string): Promise<boolean> {
  const venues = await prisma.venue.findMany({
    where: { organizationId: orgId },
    select: { id: true },
  })

  for (const venue of venues) {
    if (await moduleService.isModuleEnabled(venue.id, MODULE_CODES.SERIALIZED_INVENTORY)) {
      return true
    }
  }

  return false
}

/**
 * POST /dashboard/organizations/:orgId/manual-sales/preview
 * Dry run — classifies every row (crear / omitir / error) WITHOUT writing.
 */
export async function preview(req: Request, res: Response, next: NextFunction) {
  try {
    const { orgId } = req.params
    const { userId: actorStaffId } = (req as any).authContext
    const { rows } = req.body as BulkManualSalesInput

    if (!(await isSerializedInventoryEnabledForOrg(orgId))) {
      return res.status(403).json({ success: false, error: MODULE_DISABLED_MESSAGE })
    }

    const data = await bulkManualSales(orgId, actorStaffId, rows, false)
    res.json({ success: true, data })
  } catch (err) {
    next(err)
  }
}

/**
 * POST /dashboard/organizations/:orgId/manual-sales
 * Applies the upload — creates one complete, already-approved sale per (deduped)
 * row. Each row commits in its own transaction (Task 4/5), so one failure never
 * rolls back rows that already succeeded.
 */
export async function apply(req: Request, res: Response, next: NextFunction) {
  try {
    const { orgId } = req.params
    const { userId: actorStaffId } = (req as any).authContext
    const { rows } = req.body as BulkManualSalesInput

    if (!(await isSerializedInventoryEnabledForOrg(orgId))) {
      return res.status(403).json({ success: false, error: MODULE_DISABLED_MESSAGE })
    }

    const data = await bulkManualSales(orgId, actorStaffId, rows, true)
    res.json({ success: true, data })
  } catch (err) {
    next(err)
  }
}
