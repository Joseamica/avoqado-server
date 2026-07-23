import { NextFunction, Request, Response } from 'express'
import AppError from '@/errors/AppError'
import * as transferService from '@/services/dashboard/interVenueTransfer.service'

function staffId(req: Request): string {
  const value = req.authContext?.userId
  if (!value) throw new AppError('Se requiere una sesión autenticada', 401)
  return value
}

function idempotencyKey(req: Request): string {
  const value = req.idempotency?.key ?? req.header('Idempotency-Key')?.trim()
  if (!value) throw new AppError('Falta el header Idempotency-Key en la petición', 400)
  return value
}

export async function listTransfers(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await transferService.listInterVenueTransfers(req.params.venueId, req.query as any)
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function getTransfer(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await transferService.getInterVenueTransfer(req.params.venueId, req.params.transferId)
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function createTransfer(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await transferService.createInterVenueTransfer(req.params.venueId, req.body, staffId(req))
    res.status(201).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function approveTransfer(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await transferService.approveInterVenueTransfer(req.params.venueId, req.params.transferId, staffId(req))
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function rejectTransfer(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await transferService.rejectInterVenueTransfer(req.params.venueId, req.params.transferId, req.body.reason, staffId(req))
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function cancelTransfer(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await transferService.cancelInterVenueTransfer(req.params.venueId, req.params.transferId, req.body.reason, staffId(req))
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function dispatchTransfer(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await transferService.dispatchInterVenueTransfer(
      req.params.venueId,
      req.params.transferId,
      { ...req.body, idempotencyKey: idempotencyKey(req) },
      staffId(req),
    )
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function receiveTransfer(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await transferService.receiveInterVenueTransfer(
      req.params.venueId,
      req.params.transferId,
      { ...req.body, idempotencyKey: idempotencyKey(req) },
      staffId(req),
    )
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function resolveVariance(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await transferService.resolveInterVenueTransferVariance(
      req.params.venueId,
      req.params.transferId,
      { ...req.body, idempotencyKey: idempotencyKey(req) },
      staffId(req),
    )
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function consolidatedInventory(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await transferService.getConsolidatedRawMaterialInventory(
      req.params.venueId,
      staffId(req),
      req.query.search as string | undefined,
    )
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}
