/**
 * App de campo (bloque 0): custodia de SIMs desde el celular del promotor. El celular reintenta sin caché de
 * idempotencia, así que el estado de la SIM es la prueba: si ESTA persona ya aceptó/rechazó, el reintento es éxito.
 * El servicio ya revisa la persona (NOT_IN_YOUR_CUSTODY) antes de ALREADY_ACCEPTED / ALREADY_REJECTED.
 */
import { NextFunction, Request, Response } from 'express'
import { SimCustodyError } from '../../../lib/sim-custody-error-codes'
import { simCustodyService } from '../../../services/serialized-inventory/custody.service'
import { respondSimCustodyError } from '../simCustody.tpv.controller'

const actorDe = (req: Request) => {
  const { userId, orgId, role } = req.authContext!
  return { staffId: userId, organizationId: orgId, role }
}

export async function aceptarCustodia(req: Request, res: Response, next: NextFunction) {
  try {
    const r = await simCustodyService.accept({
      actor: actorDe(req),
      serialNumbers: req.body.serialNumbers,
      idempotencyRequestId: null,
    })
    const results = r.results.map(row =>
      row.status === 'error' && row.code === 'ALREADY_ACCEPTED'
        ? { serialNumber: row.serialNumber, status: 'ok' as const, repetida: true }
        : row,
    )
    const succeeded = results.filter(x => x.status === 'ok').length
    res.status(200).json({ summary: { total: results.length, succeeded, failed: results.length - succeeded }, results })
  } catch (err) {
    if (respondSimCustodyError(res, err)) return
    next(err)
  }
}

export async function rechazarCustodia(req: Request, res: Response, next: NextFunction) {
  try {
    const r = await simCustodyService.reject({ actor: actorDe(req), serialNumber: req.body.serialNumber })
    res.status(200).json({ ...r, repetida: false })
  } catch (err) {
    if (err instanceof SimCustodyError && err.code === 'ALREADY_REJECTED') {
      return res.status(200).json({ custodyState: 'PROMOTER_REJECTED', repetida: true })
    }
    if (respondSimCustodyError(res, err)) return
    next(err)
  }
}
