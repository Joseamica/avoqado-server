import type { Request, Response } from 'express'
import { getLinkStatus, requestLink, verifyLink, unlink } from '@/services/support/link.service'
import { listSupportVenues } from '@/services/support/access.service'
import { getDataAccess, grantDataAccess } from '@/services/support/data/consent.service'

export async function status(req: Request, res: Response) {
  res.json(await getLinkStatus(req.authContext!.userId))
}
export async function challenge(req: Request, res: Response) {
  res.json(await requestLink(req.authContext!.userId, req.body, { strongAuthAt: res.locals.supportStrongAuthAt }))
}
export async function verify(req: Request, res: Response) {
  res.json(
    await verifyLink(req.authContext!.userId, req.body, {
      strongAuthAt: res.locals.supportStrongAuthAt,
      venueId: res.locals.supportAuditVenueId,
    }),
  )
}
export async function unlinkPhone(req: Request, res: Response) {
  await unlink(req.authContext!.userId, { strongAuthAt: res.locals.supportStrongAuthAt, venueId: res.locals.supportAuditVenueId })
  res.json({ linked: false })
}
export async function venues(req: Request, res: Response) {
  res.json(
    await listSupportVenues(req.authContext!.userId, {
      search: req.query.search as string | undefined,
      cursor: req.query.cursor as string | undefined,
      limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
    }),
  )
}
export async function dataAccess(req: Request, res: Response) {
  res.json(
    await getDataAccess(req.authContext!.userId, {
      venueId: req.query.venueId as string,
      language: req.query.language as 'es' | 'en' | undefined,
    }),
  )
}
/** Never passes the clock: grantDataAccess reads it once on entry (T-B29). */
export async function grantData(req: Request, res: Response) {
  res.json(await grantDataAccess(req.authContext!.userId, req.body, { strongAuthAt: res.locals.supportStrongAuthAt }))
}
