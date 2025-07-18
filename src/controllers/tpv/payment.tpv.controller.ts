import { NextFunction, Request, Response } from 'express'
import { BadRequestError } from '../../errors/AppError'

import * as paymentTpvService from '../../services/tpv/payment.tpv.service'

export async function getPayments(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.authContext?.orgId // 1. Extract from req (Controller)

    const venueId: string = req.params.venueId // 3. Extract from req (Controller, already validated)

    // 4. Extract query parameters with defaults
    const pageSize = Number(req.query.pageSize || '10')
    const pageNumber = Number(req.query.pageNumber || '1')

    // 5. Validate pagination parameters
    if (isNaN(pageSize) || isNaN(pageNumber) || pageSize <= 0 || pageNumber <= 0) {
      throw new BadRequestError('Invalid pagination parameters. pageSize and pageNumber must be positive numbers')
    }

    // 6. Extract filter parameters from body
    const filters = {
      fromDate: req.body?.fromDate,
      toDate: req.body?.toDate,
      staffId: req.body?.staffId,
    }

    // 7. Call service with clean data (Controller delegates)
    const result = await paymentTpvService.getPayments(venueId, pageSize, pageNumber, filters, orgId)
    console.log(result)
    // 8. Send HTTP response (Controller)
    res.status(200).json({
      success: true,
      data: result.data,
      meta: result.meta,
    })
  } catch (error) {
    next(error) // 9. HTTP error handling (Controller)
  }
}
