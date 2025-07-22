import { Request, Response, NextFunction } from 'express'

import { processPosOrderEvent } from '../../services/pos-sync/posSyncOrder.service'
import { RichPosPayload } from '@/types/pos.types'

export const handlePosOrderTest = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orderPayload: RichPosPayload = req.body
    const result = await processPosOrderEvent(orderPayload)
    res.status(200).json({
      message: 'POS order processed successfully',
      order: result,
    })
  } catch (error) {
    next(error)
  }
}
