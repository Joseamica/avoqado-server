import { Request, Response, NextFunction } from 'express'
import * as balanceProviderService from '../../services/superadmin/balanceProvider.service'

/**
 * GET /api/v1/superadmin/balance-providers
 * Query params: ?active=true
 */
export async function getBalanceProviders(req: Request, res: Response, next: NextFunction) {
  try {
    const { active } = req.query
    const filters: { active?: boolean } = {}
    if (active !== undefined) filters.active = active === 'true'

    const providers = await balanceProviderService.getBalanceProviders(filters)

    res.json({ success: true, data: providers, meta: { count: providers.length } })
  } catch (error) {
    next(error)
  }
}
