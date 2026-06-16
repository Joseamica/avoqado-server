import { NextFunction, Request, Response } from 'express'

import * as journalService from '../../services/fiscal/journalEntry.service'

/**
 * Controller — Libro diario · Pólizas (Capa B). Thin. Gated en la ruta por
 * `checkFeatureAccess('CFDI')` (PREMIUM) + `accounting:read` (ver) / `accounting:manage` (postear).
 */

/** GET /accounting/journal?period=YYYY-MM — el libro diario. */
export async function getJournal(
  req: Request<{ venueId: string }, {}, {}, { period?: string; limit?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : undefined
    res.status(200).json(await journalService.listEntries(req.params.venueId, { period: req.query.period, limit }))
  } catch (error) {
    next(error)
  }
}

/** POST /accounting/journal — crea una póliza manual (balanceada). */
export async function createJournalEntry(
  req: Request<{ venueId: string }, {}, journalService.ManualEntryInput>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId: staffId } = (req as any).authContext
    const entry = await journalService.createManualEntry(req.params.venueId, req.body, { staffId })
    res.status(201).json(entry)
  } catch (error) {
    next(error)
  }
}
