import { Request, Response, NextFunction } from 'express'

import * as posSyncTestService from '../../../tests/unit/services/pos-sync/posSyncTest.service'
import { PosOrderPayload } from '@/types/pos.types'

export const handlePosOrderTest = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orderPayload: PosOrderPayload = req.body
    const result = await posSyncTestService.processTestPosOrder(orderPayload)
    res.status(200).json({
      message: 'Test order processed successfully',
      order: result,
    })
  } catch (error) {
    next(error)
  }
}
