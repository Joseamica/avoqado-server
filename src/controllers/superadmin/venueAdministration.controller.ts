import { Request, Response, NextFunction } from 'express'
import * as service from '@/services/superadmin/venueAdministration.service'

export async function getAdministration(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ data: await service.getVenueAdministration(req.params.venueId) })
  } catch (error) {
    next(error)
  }
}

export async function updateProfile(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ data: await service.updateVenueProfile(req.params.venueId, req.body, req.authContext!.userId) })
  } catch (error) {
    next(error)
  }
}

export async function updateOrganization(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ data: await service.updateVenueOrganization(req.params.venueId, req.body, req.authContext!.userId) })
  } catch (error) {
    next(error)
  }
}

export async function updateOwner(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ data: await service.updateVenueOwner(req.params.venueId, req.body, req.authContext!.userId) })
  } catch (error) {
    next(error)
  }
}

export async function updateStatus(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ data: await service.updateVenueStatus(req.params.venueId, req.body, req.authContext!.userId) })
  } catch (error) {
    next(error)
  }
}
