import { Request, Response } from 'express'

/**
 * GET /api/v1/crm/me — the caller's own CRM keys, so the console shows only the sections they open.
 * `requireCrm` already read them from the database for this request.
 */
export function getMe(req: Request, res: Response): void {
  res.json({ data: req.crmAccess })
}
