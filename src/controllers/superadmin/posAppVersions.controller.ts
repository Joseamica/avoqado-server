// Actualizador del POS — superadmin: ver, poner y quitar las versiones mínimas y calcular su impacto.
import { NextFunction, Request, Response } from 'express'
import { assertImpactCandidate, assertPolicyRules } from '../../routes/superadmin/posAppVersions.schemas'
import { clearPolicy, getPolicies, setPolicy } from '../../services/posAppVersion/policy.service'
import { getImpact } from '../../services/posAppVersion/impact.service'

type Plataforma = 'ANDROID' | 'IOS'

// El actor sale de `authContext` (lo pone el middleware de autenticación), no de `req.user`.
const actorDe = (req: Request): string => (req as any).authContext.userId

export async function list(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json({ success: true, data: await getPolicies() })
  } catch (error) {
    next(error)
  }
}

export async function put(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const platform = req.params.platform as Plataforma
    const body = req.body
    const validado = assertPolicyRules(platform, body)
    const data = await setPolicy({
      ...validado,
      message: body.message ?? null,
      expectedVersion: body.expectedVersion,
      platform,
      actorId: actorDe(req),
    })
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function clear(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await clearPolicy({
      platform: req.params.platform as Plataforma,
      expectedVersion: req.body.expectedVersion,
      actorId: actorDe(req),
    })
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function impact(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const platform = req.params.platform as Plataforma
    const query = req.query as unknown as { versionCode?: number; versionName?: string; days: number }
    const data = await getImpact({ platform, candidate: assertImpactCandidate(platform, query), days: query.days })
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}
