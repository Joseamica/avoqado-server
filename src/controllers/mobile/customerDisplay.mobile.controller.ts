// src/controllers/mobile/customerDisplay.mobile.controller.ts
import type { NextFunction, Request, Response } from 'express'
import { BadRequestError } from '../../errors/AppError'
import {
  acknowledgeCustomerDisplay,
  getMobileCustomerDisplay,
  type AckInput,
} from '../../services/customer-display/customerDisplayMobile.service'
import { requestDeviceUid } from '../../utils/requestDeviceUid'

/** El MISMO lector de `X-Device-ID` que el poll, `/settings` y `/promotions`: el aparato nunca se identifica distinto. */
function deviceUidRequerido(req: Request): string {
  const deviceUid = requestDeviceUid(req)
  if (!deviceUid) throw new BadRequestError('X-Device-ID es requerido', 'DEVICE_ID_REQUIRED')
  return deviceUid
}

/** @route GET /api/v1/mobile/venues/:venueId/customer-display */
export async function getCustomerDisplay(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getMobileCustomerDisplay(req.params.venueId, deviceUidRequerido(req))
    res.status(200).json({ data })
  } catch (error) {
    next(error)
  }
}

/** @route PUT /api/v1/mobile/venues/:venueId/customer-display/ack */
export async function acknowledgeCustomerDisplayRoute(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await acknowledgeCustomerDisplay(req.params.venueId, deviceUidRequerido(req), req.body as AckInput)
    res.status(200).json({ data })
  } catch (error) {
    next(error)
  }
}
