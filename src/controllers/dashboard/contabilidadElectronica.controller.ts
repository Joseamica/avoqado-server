import { NextFunction, Request, Response } from 'express'

import { getBalanzaXml, getCatalogoXml } from '../../services/fiscal/contabilidadElectronica.service'
import { currentPeriod } from '../../services/fiscal/trialBalance.service'

/**
 * Controller — Contabilidad electrónica (SAT, Anexo 24). Devuelve el XML (catálogo / balanza) como
 * JSON `{ xml, filename, needsFiscalSetup, empty }` para que el dashboard dispare la descarga (Blob).
 * Gated en la ruta por `checkFeatureAccess('CFDI')` (PREMIUM) + `accounting:read`.
 */

/** GET /accounting/electronic/catalogo?period=YYYY-MM — XML del catálogo de cuentas (1.3). */
export async function getCatalogoXmlController(
  req: Request<{ venueId: string }, {}, {}, { period?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const period = req.query.period || currentPeriod()
    res.status(200).json(await getCatalogoXml(req.params.venueId, period))
  } catch (error) {
    next(error)
  }
}

/** GET /accounting/electronic/balanza?period=YYYY-MM&tipoEnvio=N|C — XML de la balanza de comprobación (1.3). */
export async function getBalanzaXmlController(
  req: Request<{ venueId: string }, {}, {}, { period?: string; tipoEnvio?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const period = req.query.period || currentPeriod()
    const tipoEnvio = req.query.tipoEnvio === 'C' ? 'C' : 'N'
    res.status(200).json(await getBalanzaXml(req.params.venueId, period, tipoEnvio))
  } catch (error) {
    next(error)
  }
}
