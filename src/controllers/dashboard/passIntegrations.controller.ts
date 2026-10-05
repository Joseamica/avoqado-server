/**
 * Conector de pases (TotalPass/Wellhub) — controller del dashboard. Delgado: toma lo ya validado por el esquema, llama
 * al servicio y responde `{ success: true, data }`. Los errores de los servicios (mensaje en español + código) llegan
 * tal cual al manejador global (express-async-errors). La llave de la sucursal nunca se registra ni se devuelve.
 */
import { Request, Response } from 'express'
import * as integrations from '@/services/aggregators/passIntegrations.service'
import * as capacity from '@/services/aggregators/passCapacity.service'
import * as visits from '@/services/aggregators/passVisits.service'
import { getVenueTimezone } from '@/services/dashboard/commission/commission-utils'

/** En la URL va en minúsculas (`totalpass` · `wellhub`); el esquema ya rechazó cualquier otro. */
const providerOf = (p: string): integrations.PassProvider => (p === 'wellhub' ? 'WELLHUB' : 'TOTALPASS')
const staffOf = (req: Request): string | null => (req as any).authContext?.userId ?? null

export async function getOverview(req: Request, res: Response) {
  res.json({ success: true, data: await integrations.getPassIntegrationsOverview(req.params.venueId) })
}

export async function connectTotalPass(req: Request, res: Response) {
  res.json({ success: true, data: await integrations.connectTotalPass(req.params.venueId, req.body.placeApiKey, staffOf(req)) })
}

export async function setConfirmMode(req: Request, res: Response) {
  const data = await integrations.setPassConfirmMode(
    req.params.venueId,
    providerOf(req.params.provider),
    req.body.confirmMode,
    staffOf(req),
  )
  res.json({ success: true, data })
}

export async function setProductLinks(req: Request, res: Response) {
  const data = await integrations.setPassProductLinks(req.params.venueId, providerOf(req.params.provider), req.body.links, staffOf(req))
  res.json({ success: true, data })
}

export async function disconnect(req: Request, res: Response) {
  await integrations.disconnectPassProvider(req.params.venueId, providerOf(req.params.provider), staffOf(req))
  res.json({ success: true, data: { disconnected: true } })
}

export async function getCapacity(req: Request, res: Response) {
  res.json({ success: true, data: await capacity.getPassCapacity(req.params.venueId) })
}

export async function setDefaultCap(req: Request, res: Response) {
  await capacity.setDefaultPassCap(req.params.venueId, req.body.maxSpots, staffOf(req))
  res.json({ success: true, data: { saved: true } })
}

export async function upsertWeeklyCap(req: Request, res: Response) {
  res.json({ success: true, data: await capacity.upsertWeeklyPassCap(req.params.venueId, req.body, staffOf(req)) })
}

export async function deleteRule(req: Request, res: Response) {
  await capacity.deletePassCapRule(req.params.venueId, req.params.ruleId, staffOf(req))
  res.json({ success: true, data: { deleted: true } })
}

export async function setSessionCap(req: Request, res: Response) {
  await capacity.setSessionPassCap(req.params.venueId, req.params.classSessionId, req.body.maxSpots, staffOf(req))
  res.json({ success: true, data: { saved: true } })
}

/** `from`/`to` son días LOCALES del negocio (`to` inclusivo); `localDayRange` los vuelve instantes y rechaza fechas imposibles. */
export async function listVisits(req: Request, res: Response) {
  const venueId = req.params.venueId
  const q = req.query as {
    status?: visits.PassVisitStatus
    provider?: integrations.PassProvider
    from?: string
    to?: string
    limit?: number
    offset?: number
  }
  const range = visits.localDayRange(q.from, q.to, await getVenueTimezone(venueId))
  const data = await visits.listPassVisits(venueId, { status: q.status, provider: q.provider, limit: q.limit, offset: q.offset, ...range })
  res.json({ success: true, data })
}

export async function visitsSummary(req: Request, res: Response) {
  const venueId = req.params.venueId
  res.json({ success: true, data: await visits.summarizePassVisits(venueId, String(req.query.month), await getVenueTimezone(venueId)) })
}

export async function confirmVisit(req: Request, res: Response) {
  res.json({ success: true, data: await visits.confirmPassVisit(req.params.venueId, req.params.visitId, staffOf(req) as string) })
}

export async function rejectVisit(req: Request, res: Response) {
  res.json({ success: true, data: await visits.rejectPassVisit(req.params.venueId, req.params.visitId, staffOf(req) as string) })
}
