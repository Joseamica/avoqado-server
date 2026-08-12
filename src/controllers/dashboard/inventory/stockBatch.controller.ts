/**
 * Inventory batches (per-batch traceability and expiration).
 *
 * All the batch logic had been written and tested in `fifoBatch.service.ts` for a long
 * time and was UNREACHABLE: not a single route exposed it. Listing batches, fetching one,
 * reading statistics and holding a batch for quality all existed, and nobody could invoke
 * any of them.
 */

import { NextFunction, Request, Response } from 'express'
import { BatchStatus } from '@prisma/client'
import * as fifoBatchService from '../../../services/dashboard/fifoBatch.service'
import AppError from '../../../errors/AppError'

/** Batches of a raw material, oldest to newest — the order they will be consumed in. */
export async function getBatchesForRawMaterial(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, rawMaterialId } = req.params
    const { status } = req.query

    const batches = await fifoBatchService.getBatchesForRawMaterial(venueId, rawMaterialId, {
      status: status ? (status as BatchStatus) : undefined,
    })

    res.json({ success: true, data: batches })
  } catch (error) {
    next(error)
  }
}

/** A single batch with its raw material and the purchase order that brought it in. */
export async function getBatch(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, batchId } = req.params

    const batch = await fifoBatchService.getBatch(venueId, batchId)

    if (!batch) {
      throw new AppError('No encontramos ese lote en esta sucursal.', 404)
    }

    res.json({ success: true, data: batch })
  } catch (error) {
    next(error)
  }
}

/** Count by status and the value of live inventory. */
export async function getBatchStatistics(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { rawMaterialId } = req.query

    const stats = await fifoBatchService.getBatchStatistics(venueId, rawMaterialId as string | undefined)

    res.json({ success: true, data: stats })
  } catch (error) {
    next(error)
  }
}

/**
 * Hold a batch (quarantine warehouse).
 *
 * Pulls the batch out of the FIFO rotation and deducts its remainder from available stock,
 * leaving a movement behind. The batch keeps its remainder on record as proof of how much
 * was held.
 */
export async function quarantineBatch(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, batchId } = req.params
    const { reason } = req.body
    const staffId = (req as any).authContext?.userId

    const batch = await fifoBatchService.quarantineBatch(venueId, batchId, reason, staffId)

    res.json({ success: true, data: batch })
  } catch (error) {
    next(error)
  }
}

/**
 * Release a batch that was being held.
 *
 * Without this counterpart, quarantining would be a one-way trip and the only way out
 * would be editing the database by hand. The status it comes back to is decided by the
 * batch's own reality, not by whoever releases it: an expired batch comes back as EXPIRED
 * and does not rejoin available stock.
 */
export async function releaseBatchFromQuarantine(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, batchId } = req.params
    const { reason } = req.body
    const staffId = (req as any).authContext?.userId

    const batch = await fifoBatchService.releaseBatchFromQuarantine(venueId, batchId, reason, staffId)

    res.json({ success: true, data: batch })
  } catch (error) {
    next(error)
  }
}
