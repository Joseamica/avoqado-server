import { NextFunction, Request, Response } from 'express'

import { BadRequestError } from '../../errors/AppError'
import * as bankReconciliationService from '../../services/dashboard/bankReconciliation.service'

/**
 * Controller — Conciliación bancaria (Feature PRO `BANK_RECONCILIATION`).
 * Thin: extrae params/authContext, delega al servicio, responde.
 * Gateado en la ruta por checkFeatureAccess('BANK_RECONCILIATION') + checkPermission.
 */

export async function uploadBankStatement(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId: staffId } = (req as any).authContext
    const { venueId } = req.params as { venueId: string }
    const file = (req as any).file as { buffer: Buffer; originalname: string; mimetype: string } | undefined
    if (!file) throw new BadRequestError('No se recibió ningún archivo. Sube un CSV de tu estado de cuenta.')

    const result = await bankReconciliationService.processBankStatement(venueId, staffId, file)
    res.status(201).json(result)
  } catch (error) {
    next(error)
  }
}

export async function listBankStatements(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params as { venueId: string }
    res.status(200).json(await bankReconciliationService.listStatements(venueId))
  } catch (error) {
    next(error)
  }
}

export async function getBankStatement(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, statementId } = req.params as { venueId: string; statementId: string }
    res.status(200).json(await bankReconciliationService.getStatementDetail(venueId, statementId))
  } catch (error) {
    next(error)
  }
}

export async function confirmBankMatches(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId: staffId } = (req as any).authContext
    const { venueId, statementId } = req.params as { venueId: string; statementId: string }
    const lineIds = (req.body?.lineIds ?? []) as string[]
    res.status(200).json(await bankReconciliationService.confirmMatches(venueId, staffId, statementId, lineIds))
  } catch (error) {
    next(error)
  }
}
