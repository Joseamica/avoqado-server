import { Request, Response, NextFunction } from 'express'
import * as courses from '@/services/service-courses/serviceCourse.service'

const actorFor = (req: Request) => ({ staffId: req.authContext!.userId, ipAddress: req.ip, userAgent: req.get('user-agent') })

export async function getVenue(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ success: true, data: await courses.getVenueServiceCourses(req.params.venueId) })
  } catch (error) {
    next(error)
  }
}

export async function putVenue(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ success: true, data: await courses.putVenueServiceCourses(req.params.venueId, req.body, actorFor(req)) })
  } catch (error) {
    next(error)
  }
}

export async function getOrganization(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ success: true, data: await courses.getOrganizationServiceCourses(req.params.orgId) })
  } catch (error) {
    next(error)
  }
}

export async function putOrganization(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ success: true, data: await courses.putOrganizationServiceCourses(req.params.orgId, req.body, actorFor(req)) })
  } catch (error) {
    next(error)
  }
}

export async function getMobile(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await courses.getVenueServiceCourses(req.params.venueId)
    res.set('Cache-Control', 'private, no-cache')
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}
