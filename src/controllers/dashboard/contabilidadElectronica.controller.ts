import { NextFunction, Request, Response } from 'express'

import {
  getBalanzaXml,
  getCatalogoXml,
  getPolizasXml,
  type PolizasTipoSolicitud,
} from '../../services/fiscal/contabilidadElectronica.service'
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

/** GET /accounting/electronic/polizas?period=YYYY-MM&tipoSolicitud=&numOrden=&numTramite= — XML de pólizas (1.3). */
export async function getPolizasXmlController(
  req: Request<{ venueId: string }, {}, {}, { period?: string; tipoSolicitud?: string; numOrden?: string; numTramite?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const period = req.query.period || currentPeriod()
    const tipos: PolizasTipoSolicitud[] = ['AF', 'FC', 'DE', 'CO']
    const tipoSolicitud = tipos.includes(req.query.tipoSolicitud as PolizasTipoSolicitud)
      ? (req.query.tipoSolicitud as PolizasTipoSolicitud)
      : 'DE'
    res.status(200).json(
      await getPolizasXml(req.params.venueId, period, {
        tipoSolicitud,
        numOrden: req.query.numOrden ?? null,
        numTramite: req.query.numTramite ?? null,
      }),
    )
  } catch (error) {
    next(error)
  }
}
