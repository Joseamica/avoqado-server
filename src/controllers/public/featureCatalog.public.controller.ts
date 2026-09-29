import { Request, Response, NextFunction } from 'express'
import { listFeatureCatalog } from '@/services/launchCampaigns/featureCatalog.service'

export function getFeatureCatalog(req: Request, res: Response, next: NextFunction): void {
  try {
    res.set('Cache-Control', 'public, max-age=60')
    res.json({ success: true, data: listFeatureCatalog(req.query) })
  } catch (error) {
    next(error)
  }
}
