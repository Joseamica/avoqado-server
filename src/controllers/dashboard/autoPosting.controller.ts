import { NextFunction, Request, Response } from 'express'

import prisma from '../../utils/prismaClient'
import { generatePoliciesForVenue } from '../../services/fiscal/autoPosting.service'
import { currentPeriod } from '../../services/fiscal/trialBalance.service'

/**
 * Controller — Posteo automático de pólizas (Capa B, slice 2). Genera los asientos desde los pagos.
 * Es MUTACIÓN: gated en la ruta por `checkFeatureAccess('CFDI')` (PREMIUM) + `accounting:manage`.
 */

/** POST /accounting/generate-policies?period=YYYY-MM — genera las pólizas automáticas del periodo. */
export async function generatePoliciesController(
  req: Request<{ venueId: string }, {}, {}, { period?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const period = req.query.period || currentPeriod()
    const staffId = (req as any).authContext?.userId ?? null

    const result = await generatePoliciesForVenue(venueId, { period, actorStaffId: staffId })

    // Auditoría del batch (cada póliza ya se audita individualmente en postJournalEntry).
    if (result.posted > 0) {
      await prisma.activityLog.create({
        data: {
          action: 'AUTO_POLICIES_GENERATED',
          entity: 'JournalEntry',
          entityId: venueId,
          staffId,
          venueId,
          data: { period, posted: result.posted, alreadyPosted: result.alreadyPosted, candidates: result.candidates },
        },
      })
    }

    res.status(200).json(result)
  } catch (error) {
    next(error)
  }
}
