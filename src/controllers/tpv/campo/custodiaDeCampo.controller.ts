/**
 * App de campo (bloque 0): custodia de SIMs desde el celular del promotor. La lógica vive en
 * `services/tpv/campo/custodiaDeCampo.service.ts` (bloque 1: la gracia y «Aplicar» la usan igual); aquí sólo se arma
 * quién pide (la sucursal de la dirección, la persona del token y el rol que resolvió `checkPermission`) y se responde.
 */
import { NextFunction, Request, Response } from 'express'
import { aceptarCustodiaDeCampo, QuienCustodia, rechazarCustodiaDeCampo } from '@/services/tpv/campo/custodiaDeCampo.service'

function quienDe(req: Request): QuienCustodia {
  const { userId, role } = req.authContext!
  // El rol que `checkPermission` resolvió en ESA sucursal; el del token sólo si no lo dejó.
  return { venueId: req.params.venueId, staffId: userId, role: (req as any).resolvedRole ?? role }
}

export async function aceptarCustodia(req: Request, res: Response, next: NextFunction) {
  try {
    const r = await aceptarCustodiaDeCampo(quienDe(req), req.body)
    res.status(r.status).json(r.body)
  } catch (err) {
    next(err)
  }
}

export async function rechazarCustodia(req: Request, res: Response, next: NextFunction) {
  try {
    const r = await rechazarCustodiaDeCampo(quienDe(req), req.body)
    res.status(r.status).json(r.body)
  } catch (err) {
    next(err)
  }
}
