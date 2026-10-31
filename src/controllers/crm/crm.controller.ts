import { Request, Response } from 'express'
import { addTeamMember, listTeamMembers, removeTeamMember, updateTeamMember } from '../../services/crm/teamVenue.service'

/**
 * GET /api/v1/crm/me — the caller's own CRM keys, so the console shows only the sections they open.
 * `requireCrm` already read them from the database for this request.
 */
export function getMe(req: Request, res: Response): void {
  res.json({ data: req.crmAccess })
}

// «Equipo de ventas» (`crm:admin`). `req.crmAccess` is the admin's own keys, read by `requireCrm` for this request.

/** GET /api/v1/crm/team */
export async function listTeam(req: Request, res: Response): Promise<void> {
  // `validateRequest(listTeamSchema)` already turned them into numbers.
  const { page, pageSize } = req.query as unknown as { page?: number; pageSize?: number }
  res.json(await listTeamMembers({ page, pageSize }))
}

/** POST /api/v1/crm/team */
export async function addTeam(req: Request, res: Response): Promise<void> {
  res.status(201).json({ data: await addTeamMember(req.crmAccess!, req.body) })
}

/** PATCH /api/v1/crm/team/:id */
export async function updateTeam(req: Request, res: Response): Promise<void> {
  res.json({ data: await updateTeamMember(req.crmAccess!, req.params.id, req.body.keys) })
}

/** DELETE /api/v1/crm/team/:id */
export async function removeTeam(req: Request, res: Response): Promise<void> {
  res.json({ data: await removeTeamMember(req.crmAccess!, req.params.id, { reasignarA: req.body.reasignarA }) })
}
